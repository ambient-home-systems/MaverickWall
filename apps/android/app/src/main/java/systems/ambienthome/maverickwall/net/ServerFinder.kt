package systems.ambienthome.maverickwall.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.ArrayDeque

/**
 * Finding Maverick Wall servers on the LAN, so nobody types an address.
 *
 * This is the app half of the owner's standing objection — no hand-typed
 * addresses, no port hunting. The server advertises `_maverickwall._tcp` over
 * multicast DNS (the Phase 0 `mdns.ts` advertiser); this browses for it with the
 * platform's `NsdManager` and reports each server it resolves, by name, with the
 * host and port a screen can reach it on.
 *
 * Discovery is a convenience, never a dependency (rule nine). On a segmented or
 * guest network mDNS is often blocked, so a household can always fall back to
 * typing the address — this class simply reports nothing, and the manual field
 * beside the list stays the always-available path. Every failure is logged, none
 * throws.
 *
 * The resolve dance is deliberately serialised: the classic `resolveService`
 * permits only one in flight at a time, so discovered names are queued and
 * resolved one after another. It is the widely-compatible path down to the
 * app's `minSdk 24`; a newer per-callback resolver exists but is not needed for
 * the handful of servers a household runs.
 */
class ServerFinder(context: Context) {

    /** A resolved server: what to show, and what to connect to. */
    data class Server(val name: String, val host: String, val port: Int) {
        /** The origin a screen loads the wall from. Plain http — the LAN default. */
        val baseUrl: String get() = "http://$host:$port"
    }

    fun interface Listener {
        /** The current set of resolved servers, newest resolution last. */
        fun onServersChanged(servers: List<Server>)
    }

    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val main = Handler(Looper.getMainLooper())

    private var listener: Listener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var browsing = false

    // Serialise resolves: one at a time, the rest queued behind it.
    private val toResolve = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    /** Keyed by service name, so a re-resolve or a "lost" cleanly updates the set. */
    private val found = LinkedHashMap<String, Server>()

    /** Start browsing. Idempotent; a second call replaces the listener. */
    fun start(listener: Listener) {
        this.listener = listener
        val manager = nsd ?: run {
            Log.i(TAG, "no NSD service; discovery unavailable, manual entry still works")
            return
        }
        if (browsing) return
        browsing = true
        found.clear()
        emit()

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                // A candidate name. Resolving turns it into a host and port.
                queueResolve(serviceInfo)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                main.post {
                    if (found.remove(serviceInfo.serviceName) != null) emit()
                }
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.i(TAG, "discovery start failed ($errorCode); manual entry still works")
                browsing = false
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                browsing = false
            }
        }
        discovery = discoveryListener
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.i(TAG, "discovery could not start (${e.message}); manual entry still works")
            browsing = false
        }
    }

    /** Stop browsing and drop the listener. Safe to call more than once. */
    fun stop() {
        val manager = nsd
        val active = discovery
        if (manager != null && active != null) {
            try {
                manager.stopServiceDiscovery(active)
            } catch (_: Exception) {
                // Already stopped, or was never running.
            }
        }
        discovery = null
        browsing = false
        resolving = false
        toResolve.clear()
        listener = null
    }

    private fun queueResolve(info: NsdServiceInfo) {
        main.post {
            toResolve.addLast(info)
            pumpResolve()
        }
    }

    private fun pumpResolve() {
        if (resolving) return
        val manager = nsd ?: return
        val next = toResolve.pollFirst() ?: return
        resolving = true

        @Suppress("DEPRECATION")
        manager.resolveService(next, object : NsdManager.ResolveListener {
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                main.post {
                    @Suppress("DEPRECATION")
                    val host = serviceInfo.host?.hostAddress
                    val port = serviceInfo.port
                    if (host != null && port > 0) {
                        found[serviceInfo.serviceName] = Server(serviceInfo.serviceName, host, port)
                        emit()
                    }
                    resolving = false
                    pumpResolve()
                }
            }

            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                main.post {
                    // A failed resolve is dropped, not surfaced — the name is
                    // just not reachable right now, and the manual field covers it.
                    resolving = false
                    pumpResolve()
                }
            }
        })
    }

    private fun emit() {
        val snapshot = found.values.toList()
        listener?.onServersChanged(snapshot)
    }

    companion object {
        private const val TAG = "MaverickFinder"

        /**
         * The service type, matching `MDNS_SERVICE_TYPE` in the server's
         * `mdns.ts`. `NsdManager` wants the leading underscore and a trailing
         * dot; the server publishes `_maverickwall._tcp.local`.
         */
        private const val SERVICE_TYPE = "_maverickwall._tcp."
    }
}
