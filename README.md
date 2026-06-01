# Playlist Undo (Spicetify extension)

A safety net for Spotify playlist edits. Spotify has **no undo** when you remove a
track from a playlist — this logs every removal and lets you put it back.

## What it does
- Watches removals from your own playlists and records the track (name, artist,
  source playlist, original position, time).
- Adds a **Playlist Undo** button in the top bar (rewind icon). Click it to see
  everything you've removed and hit **Restore** to add it back.
- History is kept locally in Spicetify's storage: last 1000 removals / 90 days.
  Nothing is sent anywhere.

## How it's safe
It *wraps* the client's own `PlaylistAPI.remove` and forwards the original call
unchanged. The logging runs alongside, fire-and-forget — so if the capture logic
ever misbehaves, your removals still work normally. It can only fail to log, never
break Spotify.

Restore position is **best-effort**: it tries the original index and falls back to
appending at the end of the playlist.

## Limitations
- Only your **editable playlists** (you can't restore into someone else's playlist).
- Doesn't cover Liked Songs removals (different API) — playlists only.
- Whole-playlist deletions aren't tracked; this is per-track.

## Install
```bash
cp playlist-undo.js ~/.config/spicetify/Extensions/
spicetify config extensions playlist-undo.js
spicetify apply
```
Then fully restart Spotify.

## Uninstall
```bash
spicetify config extensions playlist-undo.js-
spicetify apply
```
