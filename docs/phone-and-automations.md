# Phone and automations

A phone shortcut or a Home Assistant automation can add to a to-do list, start
a timer, put a message on the walls, or tell the walls to reload, without
signing in. It uses a **companion token** instead of a password, and this page
has recipes for the two most common callers: an **iOS Shortcut** and a Home
Assistant **`rest_command`**. Anything else that can send an HTTP POST, such
as Tasker or a script with `curl`, works the same way.

## The token

Make it under **System › Phone and automations**. There is one per account,
and that page shows it again, replaces it or turns it off. A view-only account's
token is refused, because every request below changes something.

Anyone holding the token can do what this page lists, and nothing else: it
cannot read your lists, tick anything off, change a setting or sign in. Treat
it like a key to the front door's letterbox rather than to the door.

Send it as a header:

```
Authorization: Bearer mwc_…
```

If your app cannot send a header, put it on the end of the address as
`?key=mwc_…`. The whole address is then written down by anything it passes
through — a proxy, a router, an app's history — so use the header wherever you
can.

**The address** is the one your walls use, such as `http://192.168.1.20:8080`.
On the Home Assistant add-on that is the machine's own address and the add-on's
port, not the sidebar. A phone reaches it on your home Wi-Fi; away from home it
reaches it only if you have exposed it, and [Exposing it safely](exposing-safely.md)
is the page to read before you do.

## What you can send

Every request is a `POST` with a JSON body (a form body works too). Every
answer is JSON with `ok` and a `message` written to be read out, such as
`"Added to Shopping."` or `"Pasta timer set for 10 minutes."`, so a shortcut
can speak the answer whatever happened.

### Add to a to-do list

`list` is the list's name as **Home Assistant › To-do lists** shows it, or its
entity id. Leave it out when only one list is added. `item` is what to add.

```http
POST /companion/todo/add
Content-Type: application/json

{"list": "Shopping", "item": "Milk"}
```

It is added in Home Assistant or Todoist straight away, and a wall shows it on
its next poll.

### Start a timer

`minutes` (1 to 1440) or `seconds` (10 to 86400), one of them, and an optional
`label`. Four timers can run at once. The answer carries the timer's `id` and
`endsAt`.

```http
POST /companion/timers
Content-Type: application/json

{"minutes": 10, "label": "Pasta"}
```

### End a timer

By its `label`, by the `id` the start answered with, or every one with
`"all": true`.

```http
POST /companion/timers/end
Content-Type: application/json

{"label": "Pasta"}
```

### Send a message

`text`, and for how many `minutes` to show it: an hour when left out, a day at
most. A Messages widget on a wall shows it, and it goes on its own when the
time is up.

```http
POST /companion/messages
Content-Type: application/json

{"text": "Back at 6", "minutes": 90}
```

### Clear messages

By the `id` the message answered with, or every one with `"all": true`.

```http
POST /companion/messages/clear
Content-Type: application/json

{"all": true}
```

### Reload walls

One wall by its name, or every browser wall when you name none.

```http
POST /companion/walls/refresh
Content-Type: application/json

{"wall": "Kitchen"}
```

### Next picture

Move a rotating background on to its next picture: one wall by its name, or
every wall whose background rotates when you name none.

```http
POST /companion/walls/next-picture
Content-Type: application/json

{"wall": "Kitchen"}
```

### Show one wall's layout on every wall

`wall` is the wall whose layout to show, and `minutes` how long: ten when left
out, two hours at most. Each wall keeps its own theme.

```http
POST /companion/walls/show
Content-Type: application/json

{"wall": "Kitchen", "minutes": 30}
```

### Put every wall back

Stop showing it early. The body is empty.

```http
POST /companion/walls/show/end
Content-Type: application/json

{}
```

## An iOS Shortcut

This one adds to the shopping list by voice: "Hey Siri, add to shopping".

1. In Shortcuts, make a new shortcut and name it **Add to shopping**. Siri
   runs a shortcut by its name.
2. Add **Dictate Text**.
3. Add **Get Contents of URL**, and set the address to your server's address
   followed by `/companion/todo/add`, such as
   `http://192.168.1.20:8080/companion/todo/add`. Tap the arrow to show more:
   - **Method**: POST.
   - **Headers**: add one. Key `Authorization`, value `Bearer ` followed by
     your token.
   - **Request Body**: JSON. Add a Text field `list` with the value
     `Shopping`, and a Text field `item` whose value is the **Dictated Text**
     variable.
4. Add **Get Dictionary Value**, to get the value for `message` in the
   **Contents of URL**.
5. Add **Speak Text** (or **Show Result**) with that **Dictionary Value**.

The same four steps make any other request. For a timer, use **Ask for Input**
with the input type set to Number in place of Dictate Text, and a **Number**
field `minutes` in the body. A Text field holding digits works too, because the
server reads `"10"` as 10. For one button that does the same thing every time,
such as "Reload the walls", leave out the first step and type the body's
values.

Siri reads the `message` out whatever happened. When something is wrong it
says what, such as "No list is called that. The lists are Shopping, Chores."

## A Home Assistant `rest_command`

Put the token in `secrets.yaml`, with `Bearer ` in front of it, so it is not in
your configuration:

```yaml
maverick_wall_authorization: "Bearer mwc_…"
```

Then, in `configuration.yaml`, one `rest_command` for each request you want.
`tojson` turns a value into JSON text with its quotes, so an item with a quote
in it cannot break the body:

```yaml
rest_command:
  maverick_wall_todo_add:
    url: "http://192.168.1.20:8080/companion/todo/add"
    method: post
    headers:
      authorization: !secret maverick_wall_authorization
    content_type: "application/json"
    payload: '{"list": {{ list | tojson }}, "item": {{ item | tojson }}}'

  maverick_wall_timer:
    url: "http://192.168.1.20:8080/companion/timers"
    method: post
    headers:
      authorization: !secret maverick_wall_authorization
    content_type: "application/json"
    payload: '{"minutes": {{ minutes | int }}, "label": {{ label | tojson }}}'

  maverick_wall_message:
    url: "http://192.168.1.20:8080/companion/messages"
    method: post
    headers:
      authorization: !secret maverick_wall_authorization
    content_type: "application/json"
    payload: '{"text": {{ text | tojson }}, "minutes": {{ minutes | int }}}'

  maverick_wall_refresh:
    url: "http://192.168.1.20:8080/companion/walls/refresh"
    method: post
    headers:
      authorization: !secret maverick_wall_authorization
    content_type: "application/json"
    payload: "{}"
```

Restart Home Assistant, or reload the YAML, and each becomes an action. This
automation puts a message on the walls when the washing machine finishes:

```yaml
automation:
  - alias: "Tell the walls the washing is done"
    triggers:
      - trigger: state
        entity_id: sensor.washing_machine_status
        to: "finished"
    actions:
      - action: rest_command.maverick_wall_message
        data:
          text: "The washing is done"
          minutes: 60
```

And this one adds to the shopping list when a button by the fridge is pressed:

```yaml
automation:
  - alias: "Out of milk"
    triggers:
      - trigger: state
        entity_id: input_button.out_of_milk
    actions:
      - action: rest_command.maverick_wall_todo_add
        data:
          list: "Shopping"
          item: "Milk"
```

Home Assistant can already add to its own to-do lists without this. The
`todo/add` request is for a Todoist project, and for adding from somewhere
that is not Home Assistant.

## When it says no

| Status | `error` | What it means |
|---|---|---|
| 400 | `bad-body` | The body is missing something or has a key it does not know. The `message` says which. |
| 401 | `no-token` | No token was sent. |
| 401 | `bad-token` | The token is not one. It may have been replaced: copy it again. |
| 403 | `view-only` | The token belongs to a view-only account. |
| 404 | `not-found`, `none-watched` | No list, wall, timer or message matched; the `message` names what there is. |
| 409 | `which`, `ambiguous` | More than one list or wall could be meant. Say which. |
| 409 | `refused`, `not-rotating` | It cannot be done just now, such as a fifth timer, or a next picture for a wall whose background does not rotate. |
| 429 | `rate-limited` | Twenty wrong tokens from one address in five minutes, or thirty requests from one account in a minute. `Retry-After` says how long to wait. |
| 502, 503 | `upstream`, `connection` | Home Assistant or Todoist did not take the item. |

An address told to wait after wrong tokens can be released early under
**System › Lockouts**.

Nothing about a request is written to the log, on success or refusal. What the
page under **System › Phone and automations** shows is when the token was last
used.
