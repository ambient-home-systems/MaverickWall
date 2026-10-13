/**
 * One frame as a part of our own `multipart/x-mixed-replace` stream (plan item
 * M6.2). The boundary is ours, whatever the camera's was: the hub re-frames
 * every picture, so a wall reads one well-formed stream however the source
 * spelled its own (RFC 007 §5.1).
 */

export const CAMERA_BOUNDARY = 'mw-camera-frame';

export function cameraPart(frame: Uint8Array): Uint8Array {
  const head = Buffer.from(
    `--${CAMERA_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    'latin1',
  );
  const tail = Buffer.from('\r\n', 'latin1');
  return new Uint8Array(Buffer.concat([head, Buffer.from(frame), tail]));
}
