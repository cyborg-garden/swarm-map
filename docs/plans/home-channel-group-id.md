# Plan: Signal Home Channel Group ID Resolution

## Problem

Signal home channels are stored as raw env var values (phone numbers or display names), but Signal groups require group UUIDs for message delivery. When `SIGNAL_HOME_CHANNEL` is set to a display name, messages cannot be delivered because `_send_signal()` needs a `group:<groupId>` format chat_id.

## Current Behavior

### Home channel parsing (`gateway/config.py:798-804`)

```python
signal_home = os.getenv("SIGNAL_HOME_CHANNEL")
if signal_home and Platform.SIGNAL in config.platforms:
    config.platforms[Platform.SIGNAL].home_channel = HomeChannel(
        platform=Platform.SIGNAL,
        chat_id=signal_home,       # Raw env var value, no resolution
        name=os.getenv("SIGNAL_HOME_CHANNEL_NAME", "Home"),
    )
```

The `chat_id` is stored verbatim from the env var. No resolution to group UUID occurs at config time.

### Message delivery (`tools/send_message_tool.py:180-184`)

When no explicit target is given, `chat_id` falls back to the home channel:

```python
if not chat_id:
    home = config.get_home_channel(platform)
    if home:
        chat_id = home.chat_id  # Uses raw value from config
```

### Signal send (`tools/send_message_tool.py:663-664`)

The `_send_signal()` function routes based on the `group:` prefix:

```python
if chat_id.startswith("group:"):
    params["groupId"] = chat_id[6:]
else:
    params["recipient"] = [chat_id]
```

If `SIGNAL_HOME_CHANNEL` is set to a display name like `"My Team"`, the send call treats it as a phone number recipient, which fails.

### Incoming message format (`gateway/platforms/signal.py:587-605`)

Incoming group messages provide the group ID via `dataMessage.groupInfo.groupId`. The internal chat_id is constructed as `f"group:{group_id}"`.

### Group allowlist (`gateway/platforms/signal.py:192-193, 596-602`)

`SIGNAL_GROUP_ALLOWED_USERS` already uses raw group IDs (base64-encoded UUIDs from signal-cli). The allowlist filters on `group_id` directly, which works because users set the base64 group ID.

## What Needs to Change

### 1. Accept group ID directly in `SIGNAL_HOME_CHANNEL` (primary path)

Allow users to set `SIGNAL_HOME_CHANNEL=group:<base64-group-id>`. This is the simplest fix and aligns with how chat_id is represented internally.

**File:** `gateway/config.py` (~798-804)
- If the value starts with `group:`, store it as-is in `chat_id`
- If it looks like a base64 group ID (no `group:` prefix, matches base64 pattern), auto-prefix with `group:`
- If it's a phone number (E.164), store as-is (DM home channel)

### 2. Add display-name resolution via `listGroups` RPC (fallback)

For backward compatibility, resolve display names to group IDs at adapter startup.

**File:** `gateway/platforms/signal.py`
- Add `_resolve_home_channel_group_id()` method, called after `connect()` alongside `_resolve_allowlist_uuids()` (~line 299)
- Use signal-cli's `listGroups` RPC (params: `{"account": self.account}`) to get all groups with their names and IDs
- Match the home channel value against group names (case-insensitive)
- Update `config.platforms[Platform.SIGNAL].home_channel.chat_id` to `group:<matched-id>`
- Log a deprecation warning: "SIGNAL_HOME_CHANNEL is set to a display name; use group:<id> instead"

### 3. Expose group list in channel directory

**File:** `gateway/channel_directory.py` or `gateway/platforms/signal.py`
- When building the channel directory (`action=list`), include known Signal groups with their display names and group IDs
- This lets users discover the correct group ID to configure

### 4. Documentation update

**File:** `website/docs/user-guide/messaging/signal.md` (~line 111, 239)
- Document the `group:<id>` format for `SIGNAL_HOME_CHANNEL`
- Add instructions for finding group IDs (via `hermes send_message action=list` or signal-cli directly)

## Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `gateway/config.py` | Auto-detect and normalize `group:` prefix | ~5 lines |
| `gateway/platforms/signal.py` | Add `_resolve_home_channel_group_id()`, call after connect | ~30 lines |
| `tools/send_message_tool.py` | No changes needed (already handles `group:` prefix) | 0 |
| `gateway/channel_directory.py` | Expose Signal groups in list output | ~10 lines |
| `website/docs/user-guide/messaging/signal.md` | Document group ID format | ~10 lines |
| `tests/gateway/test_config.py` | Test group ID normalization | ~15 lines |
| `tests/gateway/test_signal.py` | Test home channel resolution | ~20 lines |

## Migration Strategy

1. **No breaking change.** Display-name values continue to work via runtime resolution.
2. Config parsing normalizes `group:` prefix immediately (no adapter needed).
3. Adapter resolves display names lazily at connect time, with a deprecation warning in logs.
4. Future version (v2) can drop display-name resolution and require group IDs.

## Estimated Scope

- **4 files** modified (config, signal adapter, channel directory, docs)
- **2 test files** updated
- **~90 lines** of implementation code
- **Low risk** -- additive change, existing behavior preserved as fallback
