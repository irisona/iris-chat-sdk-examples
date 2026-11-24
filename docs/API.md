# @irisme/chat-sdk API Reference


## Contents

- [Quick start](#quick-start)
- [`Iris` namespace](#iris-namespace)
- [`ChatChannel`](#chatchannel)
- [Client tools](#client-tools)
- [`SpeechChannel`](#speechchannel)
- [`AudioPlayer`](#audioplayer)
- [Token storage](#token-storage)
- [Types](#types)
- [Error handling](#error-handling)

## Quick start

```ts
import { Iris } from "@irisme/chat-sdk";

// Optional: sign in first so the chat session is tied to a real user instead of a guest.
// createChatSession()/connect() below pick up the stored token automatically — no need to
// pass it again yourself.
await Iris.authorize({ provider: "geoguessr", idToken });

// Omit this call entirely (and opts.token below) for a guest session.
const session = await Iris.createChatSession("persona_id");
const channel = Iris.connect(session.accessKey, { mode: "text", clientLanguage: navigator.language });

channel.on("persona_message_chunk", (e) => appendToBubble(e.id, e.delta));
await channel.createIntent("reply", { text: "hey!" });

// Resuming a session? Load what was already said, oldest first.
const history = await Iris.getChatHistory(session.accessKey);
```

## `Iris` namespace

Everything the SDK exposes hangs off this one object.

### `Iris.createChatSession(personaId, opts?)`

```ts
function createChatSession(personaId: string, opts?: { token?: string; modeId?: string }): Promise<ChatSession>;
```

Opens a new chat session against a persona. Pass
`opts.token` (a bearer token from `Iris.authorize()` or your own auth flow) for a signed-in
session, or omit it for a guest session — the backend issues one from the anonymous request.
Resolves to `{ accessKey }`, the capability string that authorizes `Iris.connect()` and
`Iris.getChatHistory()`.

Pass `opts.modeId` to run the session in a specific persona mode (a `PersonaMode` id, e.g.
`persona.currentMode.id` from `Iris.getPersona()`). Omit it and the backend uses the persona's
current mode. The mode is bound to the session at creation: `Iris.connect()` sends no mode, so
reconnecting to an existing `accessKey` keeps the mode it was created with — create a new session
to switch modes.

```ts
const session = await Iris.createChatSession("persona_id", { modeId: "mode_id" });
```

Unlike the main app, this **never** falls back to a bundled guest credential — this package ships
to third-party sites, so no such secret exists here. No token means no `Authorization` header at
all.

### `Iris.connect(accessKey, opts)`

```ts
function connect(accessKey: string, opts: ConnectOptions): ChatChannel;

interface ConnectOptions {
  mode?: ChatMode; // "text" | "audio_text", default "text"
  token?: string;
  clientLanguage?: string;
  personaId: string;
  speech?: SpeechOptions;
}

interface SpeechOptions {
  speed?: number; // Fish Audio voices only, 0.5-2.0
}
```

Opens (synchronously returns) a [`ChatChannel`](#chatchannel) joined to `session:{accessKey}` over
Phoenix. The `accessKey` embedded in the topic is itself the capability that authorizes the
channel — no bearer token is sent in the join payload. `opts.token` (falling back to whatever
`Iris.authorize()` last stored) is only used for the socket's own connect params and for the
speech subsystem's provider-token lookups.

`opts.personaId` is required even for `mode: "text"` — a channel constructed as text-only can
still be switched into voice with `channel.setMode("audio_text")` later, and by then it's too late
to ask for a personaId. See [why voice needs it](#speechchannel) below.

`opts.speech.speed` sets how fast a Fish Audio persona speaks, replacing the persona's own speed.
It works the same as [`speech.setSpeed()`](#speechsetspeedspeed) called before the first reply.

### `Iris.getChatHistory(accessKey, opts?)`

```ts
function getChatHistory(accessKey: string, opts?: { limit?: number; token?: string }): Promise<HistoryMessage[]>;
```

Fetches one page of the most recent `opts.limit` (default 50) messages, returned **oldest first**
(the wire itself is newest-first; the SDK reverses it for you). Only plain chat turns come back —
tool-use synthetic entries are skipped.

> ⚠️ There is currently no working pagination past that one page — the backend's filter is a
> lower bound only (messages at-or-after some point in time), with no upper-bound equivalent, and
> the response never carries a pagination cursor of its own.

#### Planned: `opts.from` / `opts.before`

**Not implemented yet** — `src/session.ts` doesn't accept either option today. Documented here as
the intended contract for a future change, based on what the backend actually supports:

```ts
opts?: {
  limit?: number;
  token?: string;
  from?: string;   // ISO8601 timestamp, inclusive lower bound — sent to the backend as-is
  before?: string;  // ISO8601 timestamp, exclusive upper bound — enforced client-side only
};
```

- **`from`** maps directly to a real backend filter: "messages at or after this point in time."
  The backend has no equivalent upper-bound filter, so this is the only side a request can
  actually narrow.
- **`before`** can't be sent to the backend at all — there's nothing there to receive it. To honor
  it, the SDK would have to omit `limit` (which makes the backend return the *entire* session
  history in one response), then filter that full set down to `[from, before)` and apply `limit`
  client-side, keeping the most recent messages within that window. That means passing `before`
  turns a normal one-page request into a full-history fetch under the hood — worth knowing before
  reaching for it on a long-running conversation.

### `Iris.getPersona(personaId, opts?)`

```ts
function getPersona(personaId: string, opts?: { token?: string }): Promise<Persona>;
```

Fetches a persona's own public profile info (`GET /v1/personas/:id`) — the same endpoint
`SpeechChannel` already calls internally to resolve voice config. `opts.token` falls back to
whatever `Iris.authorize()` last stored, same as elsewhere; personas that aren't public require a
signed-in token with access to them. Rejects on a non-OK HTTP response.

Only exposes a lean, public-facing subset of what the backend returns — this package ships to
third-party sites, so admin-only fields (`monetization`, `user_id`, `xp`, `draft`, invitation
codes, etc.) are deliberately left out.

### `Iris.authorize(credential)`

```ts
function authorize(credential: Credential): Promise<{ user: User }>;

type Credential = { provider: string; [key: string]: unknown };
```

Signs in and stores the resulting session (token, refresh token, expiry, user) via the configured
[storage adapter](#token-storage). `provider` identifies a partner site's own auth — e.g.
`"geoguessr"` — and the credential is forwarded **as-is**, matching whatever fields that partner
integration's backend contract expects, in wire (snake_case) form.

Once authorized, the SDK schedules its own silent refresh ~30s before `expiresAt`, and retries a
refresh exactly once if `ChatChannel` sees a `401`/`"unauthorized"` join error or an unexpected
socket close.

### `Iris.getCurrentUser()`

```ts
function getCurrentUser(): User | null;
```

Returns the user from the last successful `Iris.authorize()` call (rehydrated from storage on
`configure()`, if that adapter had a live, non-expired session). `null` for guests, and `null` if
you never call `Iris.authorize()` — this does **not** reflect an externally-obtained bearer token
passed straight into `createChatSession`/`connect`.

### `Iris.onAuthChange(cb)`

```ts
function onAuthChange(cb: (user: User | null) => void): Unsubscribe;
```

Fires on every sign-in, sign-out, and successful silent refresh. Call the returned function to
unsubscribe.

### `Iris.configure(opts)`

```ts
function configure(opts: { storage?: TokenStorageAdapter }): void;
```

Swaps the token storage adapter (see [Token storage](#token-storage)) and immediately attempts to
rehydrate a session from it. Call this once, before `Iris.authorize()`, if you want sessions to
survive a page reload.

## `ChatChannel`

Returned by `Iris.connect()`. Wraps one Phoenix channel (`session:{accessKey}`) plus a
[`SpeechChannel`](#speechchannel) for voice playback.

```ts
class ChatChannel {
  state: ChatChannelState; // "connecting" | "joined" | "errored" | "closed"
  mode: ChatMode; // "text" | "audio_text"
  speech: SpeechChannel; // always present; only its socket is lazy

  on<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): Unsubscribe;
  off<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): void;
  once<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): Unsubscribe;

  setMode(mode: ChatMode): void;
  createIntent(type: IntentType, payload: unknown, opts?: { tools?: ClientTool[] }): Promise<IntentResult>;
  disconnect(): void;
}
```

### `channel.on(event, cb)` / `off` / `once`

Typed pub/sub over [`ChatEvent`](#chatevent). `cb`'s parameter type narrows automatically to the
event you subscribed to.

### `channel.setMode(mode)`

Switches between `"text"` and `"audio_text"`. Lazily opens or tears down the speech socket —
`channel.speech` itself is always the same object, so listeners attached once (e.g. on
`channel.speech.player`) keep working across mode toggles. A no-op if `mode` is unchanged.

### `channel.createIntent(type, payload, opts?)`

```ts
type IntentType =
  | "reply"
  | "continuation"
  | "initiation"
  | "extra_context"
  | "selfintroduction"
  | "tool_continuation";

interface IntentResult {
  id: string;
  status: "sent" | "failed";
  error?: ChatError;
}
```

Sends a `new_message` push and resolves once the backend acks it (`"sent"`) or rejects it
(`"failed"`, with `error`). This resolves on **delivery**, not on the persona's reply — listen for
`persona_message`/`persona_message_chunk` events for that.

| `type` | Payload | Use |
|---|---|---|
| `"reply"` | `{ text: string }` or a plain `string` | Normal user turn. Emits a synthesized `user_message` event locally (the wire never echoes it back). In `"audio_text"` mode, this also stops any in-flight speech playback — a new send always interrupts, mirroring the app's barge-in behavior, so most consumers never call `player.stop()` themselves. |
| `"continuation"` | same as `"reply"` | Hands the persona context to carry on from (e.g. "the user picked the blue one"), without it reading as something the user said. Wire-encoded specially (`context` instead of `content`), ported verbatim from the main app. |
| `"initiation"` | `{}` | Opens the conversation with no user input — the persona speaks first, whatever it'd naturally open with. |
| `"selfintroduction"` | `{}` | Asks the persona to introduce itself specifically. |
| `"extra_context"` | `{ text: string }` | Same shape as `"reply"`, different wire intent type. |
| `"tool_continuation"` | `ToolResult[]` or a single `ToolResult` | Answers a tool call that is waiting on the client, by the call's message id. See [Answering a call](#answering-a-call). `result` is a free-form object (`Record<string, unknown>`), sent to the persona as it stands. An empty list, or a result without a string `messageId` or an object `result`, resolves `"failed"` with `reason: "invalid_tool_results"` and sends nothing. |

`opts.tools` offers [client tools](#client-tools) to the persona on this push.

Multiple `createIntent()` calls are matched to their `intent:created` acks strictly FIFO — don't
rely on out-of-order resolution.

### `channel.disconnect()`

Leaves the Phoenix channel, disconnects the socket, disconnects `channel.speech` (which also stops
any playing audio), and transitions `state` to `"closed"`. Always call this on teardown (page
unload, component unmount, switching personas) — see both example apps for the pattern.

## Client tools

A client tool is a tool your page runs instead of the backend. You describe it to the persona,
the persona decides when to call it from what the user says, and your code does the work. For
example, a "next" button can become something the user says out loud ("show me someone else"),
in their own words and in any language.

```ts
interface ClientTool {
  name: string;
  description: string; // tells the model when to call it, so be specific
  parameters: Record<string, unknown>; // JSON Schema for the arguments, passed to the model as is
}
```

### Lifecycle

1. **Offer.** Pass the tools to `createIntent(type, payload, { tools })`. The model only sees the
   tools carried by the push in front of it. To keep an offer open across turns, pass the same
   tools on every intent until the user has answered.
2. **Call.** When the persona calls one, a `tool_use` event arrives with
   `payload.name === tool.name`. It's the same event used for backend tools, so check the name.
   Any other fields on the call are passed through as the backend sends them (wire snake_case,
   not renamed).
3. **Act.** Do whatever the tool stands for in your UI.
4. **Answer.** The persona's turn ends on the call and waits for you. It never sends a final
   `persona_message` for that turn. The SDK closes the turn for you: it resets the streaming id
   and, in `"audio_text"` mode, flushes speech, so the next turn starts clean. Then send
   whatever the conversation should continue with (see [below](#answering-a-call)).
5. **Take down.** Stop passing `tools` once the choice is made. Nothing is held between pushes, so
   there is nothing to clear.

### Example

```ts
const NEXT_TOOL = "user_wants_next_persona";

const tools = [
  {
    name: NEXT_TOOL,
    description:
      "The user is done here and wants to meet someone else. Call this as soon as they say so " +
      "(\"next\", \"someone else\", anything that means it), without asking them to confirm.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
  }
];

let settled = false;

// Every send carries the tools until the user has made their choice.
const send = (text: string) => channel.createIntent("reply", { text }, settled ? undefined : { tools });

channel.on("tool_use", (e) => {
  if (e.payload.name !== NEXT_TOOL || settled) return;

  // The persona may say it again after being told what the user wants. Act only once.
  settled = true;
  channel.disconnect();
  openNextPersona();
});
```

### Answering a call

There are two ways to continue after a call, depending on whether the call can be answered by id:

- **With a result**: `createIntent("tool_continuation", [{ messageId, result }])` answers that
  exact call. `messageId` is the call's own message id. The built-in `signup` tool exposes it as
  `payload.messageId`:

  ```ts
  channel.on("tool_use", async (e) => {
    if (e.payload.name !== "signup") return;

    await Iris.authorize(credential);
    await channel.createIntent("tool_continuation", [
      { messageId: e.payload.messageId, result: { sign_up: true, message: "user has successfully signed in" } }
    ]);
  });
  ```

- **With context**: `createIntent("continuation", { text })` tells the persona what happened in
  plain words, for example "The user chose to keep talking with you. Carry on the conversation."
  Use this when the call has nothing to report back, or when you don't need to tie the answer to
  that call.

If you don't send anything, the conversation just waits for the user's next `reply`, which is
fine when your UI has already moved on (like the example above).

### Tips

- **Write descriptions as instructions to the model.** Say when to call the tool and when not to:
  "only when they mean it about this conversation, not for a passing compliment." Vague
  descriptions get vague calls.
- **The persona can call a tool more than once.** Guard your handler, as `settled` does above.
- **Name collisions:** choose names that can't clash with the built-in tools listed under
  [`ToolUsePayload`](#toolusepayload). If you refer to a client tool by name in instruction text
  you send the persona (e.g. a `continuation`), use the `client__` prefix, as in
  `client__user_wants_next_persona`. That's the name the model sees. `tool_use` events give you
  back the plain name.

## `SpeechChannel`

`channel.speech` — a separate WebSocket connection for TTS playback, kept distinct from the chat
channel so a TTS failure never gets conflated with a chat-channel failure. Speaks either
ElevenLabs' JSON protocol or Fish Audio's msgpack-framed one, chosen per-persona from
`persona.voice.provider_name`.

```ts
class SpeechChannel {
  state: SpeechState; // "connecting" | "connected" | "errored" | "closed"
  player: AudioPlayer;

  on<K extends SpeechEventType>(event: K, cb: (e: Extract<SpeechEvent, { type: K }>) => void): Unsubscribe;
  setSpeed(speed: number | undefined): void;
  disconnect(): void;
}
```

You normally don't call anything else on it directly — `ChatChannel.setMode("audio_text")` drives
`activate()`/`deactivate()`, and streaming persona text is routed into it automatically. Just
subscribe to its events and to `channel.speech.player`.

### `speech.setSpeed(speed)`

Sets how fast a **Fish Audio** persona speaks. ElevenLabs personas ignore it — `Iris.getPersona()`
tells you the voice provider if you want to hide your speed control for them.

- The value replaces the persona's own speed (it doesn't scale it).
- It's clamped to 0.5–2.0, Fish Audio's documented range for `prosody.speed` (1.0 = normal,
  0.5 = half, 2.0 = double; see Fish's [live TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-live-with-timestamps)
  and [TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) references).
  `3` plays at 2.0, `0.1` at 0.5. `undefined`, `NaN` or `Infinity` goes back to the persona's own speed.
- A reply that's already playing keeps its speed; the change is heard from the next reply on,
  including the first reply after `setMode("audio_text")`.

```ts
channel.speech.setSpeed(1.25);
```

#### How a change reaches the next reply

Fish Audio fixes the speed in the `start` frame each socket sends when it opens (`prosody.speed`),
and a socket can't change it afterwards. The SDK opens a fresh socket for every reply, so in most
cases the new speed simply rides on the next one.

The exception is the socket `setMode("audio_text")` opens straight away, before any reply, which
the first reply then reuses. If the speed changes while that socket is open and unused, the SDK
marks it stale, and the next reply opens a new socket with the new speed instead of reusing it.
That costs one extra connection and one extra provider token, and only when the speed really
changes:

- Setting the speed back to the value the open socket already uses clears the stale mark, so
  nothing reconnects.
- ElevenLabs personas are never marked stale, because `setSpeed` doesn't affect them.
- A change made while a reply is streaming doesn't cut that reply. Its socket is replaced at the
  next reply anyway.
- `setMode("text")` and `disconnect()` drop the mark along with the socket.

### `speech.on(event, cb)`

```ts
type SpeechEvent =
  | { type: "subtitle_chunk"; id: string; text: string; startMs: number; durationMs: number }
  | { type: "audio_chunk"; id: string; pcm: ArrayBuffer }
  | { type: "error"; error: ChatError }
  | { type: "state_change"; state: SpeechState };
```

- **`subtitle_chunk`** — one word at a time, with its timing relative to that message's own
  playback start (`AudioPlayer.currentTime` resets the same way, per message id). Use this to
  drive karaoke-style captions — see the `subtitle_chunk` handler in
  [`react/src/useChatChannel.ts`](../react/src/useChatChannel.ts) and `buildTextSegments` in
  [`react/src/ChatWidget.tsx`](../react/src/ChatWidget.tsx) for a full implementation.
- **`audio_chunk`** — raw PCM (16kHz, mono) for the current message. You don't need to do anything
  with this yourself; it's already been handed to `player.enqueue()`. Useful only if you want to
  do your own visualization/recording.
- **`error`** — socket failed to open, or a frame failed to decode.
- **`state_change`** — mirrors `speech.state`.

## `AudioPlayer`

`channel.speech.player` — gapless PCM playback via Web Audio. Ported from the main app's
`useSpeechOutCore`.

```ts
class AudioPlayer {
  state: AudioPlayerState; // "idle" | "playing"
  currentMessageId: string | null;
  currentTime: number; // ms elapsed in the current message's playback, polled ~60fps internally

  on(event: "state_change", cb: (state: AudioPlayerState) => void): Unsubscribe;
  stop(): void;
}
```

- **`currentTime`** has no dedicated change event — poll it (the [React example](../react/src/useChatChannel.ts) uses a `setInterval`,
  16–80ms) if you're driving a UI off it, e.g. caption highlighting.
- **`stop()`** is a hard interrupt: drops everything queued/scheduled and silences immediately by
  swapping the internal `GainNode` rather than stopping every buffer source by hand. `reply`
  intents in `"audio_text"` mode call this for you already (barge-in); call it yourself for an
  explicit "stop speaking" control.

## Token storage

```ts
interface TokenStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
```

The default adapter is in-memory — nothing survives a page reload unless you opt in:

```ts
import { Iris, localStorageAdapter } from "@irisme/chat-sdk";

Iris.configure({ storage: localStorageAdapter });
```

Bring your own adapter (e.g. wrapping `AsyncStorage` on React Native) by implementing the three
methods above.

## Types

All exported from the package root.

| Type | Shape |
|---|---|
| `ChatSession` | `{ accessKey: string }` |
| `Persona` | `{ id, name, avatar?, defaultLanguage, disabledFeatures, voiceStyle?, selfIntroduction?, currentMode? }` |
| `PersonaMode` | `{ id, name, description }` |
| `User` | `{ id: string; [key: string]: unknown }` |
| `HistoryMessage` | `{ id, role: "user" \| "persona", text, mediaAttachments?, insertedAt }` |
| `MediaAttachment` | `{ mediaId, name, mediaUrl? }` |
| `ClientTool` | `{ name, description, parameters }`. See [Client tools](#client-tools). |
| `ToolResult` | `{ messageId: string; result: Record<string, unknown> }` |
| `ChatError` | `{ category?, message?, reason?, [key: string]: unknown }` |
| `ChatMode` | `"text" \| "audio_text"` |
| `ChatChannelState` | `"connecting" \| "joined" \| "errored" \| "closed"` |
| `SpeechState` | `"connecting" \| "connected" \| "errored" \| "closed"` |
| `AudioPlayerState` | `"idle" \| "playing"` |
| `Unsubscribe` | `() => void` |

### `ChatEvent`

```ts
type ChatEvent =
  | { type: "user_message"; id: string; text: string }
  | { type: "persona_message_chunk"; id: string; delta: string }
  | { type: "persona_message"; id: string; content: string; mediaAttachments?: MediaAttachment[] }
  | { type: "tool_use_start"; tool: string }
  | { type: "tool_use"; payload: ToolUsePayload }
  | { type: "reply_suggestions"; suggestions: string[] }
  | { type: "task_update"; id: string; status: string }
  | { type: "energy_balance"; balance: number }
  | { type: "error"; error: ChatError }
  | { type: "state_change"; state: ChatChannelState };
```

- **`user_message`** is synthesized locally by `createIntent("reply", …)` — the wire never echoes
  the caller's own message back.
- **`persona_message_chunk`** fires per streaming delta; the first chunk of a turn assigns the
  `id` that all of that turn's events (including the final `persona_message`) share.
- **`persona_message`** is the final, complete text for a turn (may carry `mediaAttachments` with
  empty `content` when the turn is media-only).
- **`tool_use_start`** / **`tool_use`** bracket a persona action (image/video/voice generation,
  avatar changes, persona creation, etc.) — see `ToolUsePayload` below for the typed cases and
  their extra fields.
- **`reply_suggestions`** — quick-reply chips the persona/backend suggests. Also fires right after
  a successful join (just after `state_change` → `"joined"`) when the session has opening
  suggestions, so subscribe before the channel joins to catch them.
- **`energy_balance`** — the user's remaining energy/credits after this turn.

### `ToolUsePayload`

```ts
type ToolUsePayload =
  | { name: "image_generation"; mediaUrl?: string }
  | { name: "video_generation"; id?: string; status?: string; mediaUrl?: string }
  | { name: "voice_generation"; voices?: unknown[] }
  | { name: string; [key: string]: unknown }; // any other tool name, raw fields passed through
```

This is the SDK's own typed source of truth for tool-use payloads — there was no formal union
server-side to port from. The three shown above are the common cases; the fallback arm covers
every other `name` the backend can send (avatar changes, persona creation/drafting, signup,
energy package selection, and more) — treat those as forward-compatible and read whatever fields
you need off them. Calls to your own [client tools](#client-tools) arrive through this fallback
arm too.

## Error handling

- **`ChatChannel`**: subscribe to the `"error"` event. Join failures (bad/expired accessKey,
  timeout) and mid-session `phx_error`/`error` frames all surface here with a `ChatError`. A join
  error whose `category` contains `"unauthorized"` triggers one automatic refresh-and-retry via
  the token store — you don't need to handle that case specially.
- **`SpeechChannel`**: separately, subscribe to `speech.on("error", …)`. A speech-socket failure
  (e.g. the persona has no active voice configured, or the socket itself errors) never surfaces on
  the chat channel's `"error"` event.
- **`createIntent()`**: also reports failures inline via its resolved `IntentResult.status` —
  check `status === "failed"` in addition to (or instead of) listening for `"error"`.
- **Promise rejections**: `Iris.createChatSession`, `Iris.getChatHistory`, and `Iris.authorize`
  reject (rather than emitting an event) on a non-OK HTTP response — wrap those calls in
  `try/catch`.
