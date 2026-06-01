// Playlist Undo — a Spicetify extension
// Logs every track you remove from your own playlists and lets you put it back.
// Spotify has no undo for playlist edits; this is a safety net.
//
// Design notes:
//  - We WRAP Platform.PlaylistAPI.remove so we snapshot what's being removed
//    *before* the real removal runs. The original call is always forwarded
//    unchanged, so a bug here can only fail to log — it can never break removal.
//  - Snapshots (track name/artist/position) are kept in Spicetify.LocalStorage,
//    pruned to the last 1000 entries / 90 days. Nothing leaves your machine.

(function PlaylistUndo() {
  const S = window.Spicetify;
  if (
    !S ||
    !S.Platform ||
    !S.Platform.PlaylistAPI ||
    !S.Topbar ||
    !S.LocalStorage ||
    !S.PopupModal
  ) {
    setTimeout(PlaylistUndo, 300);
    return;
  }

  const STORE_KEY = "playlist-undo:trash";
  const MAX_ENTRIES = 1000;
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  const api = S.Platform.PlaylistAPI;

  // ---------- storage ----------
  function load() {
    try {
      const raw = S.LocalStorage.get(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }
  function commit(arr) {
    const now = Date.now();
    let pruned = arr.filter((e) => now - e.removedAt < MAX_AGE_MS);
    if (pruned.length > MAX_ENTRIES) pruned = pruned.slice(pruned.length - MAX_ENTRIES);
    S.LocalStorage.set(STORE_KEY, JSON.stringify(pruned));
    return pruned;
  }
  function addEntries(entries) {
    commit(load().concat(entries));
  }
  function removeEntry(id) {
    commit(load().filter((e) => e.id !== id));
  }
  function clearAll() {
    S.LocalStorage.set(STORE_KEY, "[]");
  }

  // ---------- capture removals ----------
  async function getPlaylistName(uri) {
    try {
      const md = await api.getMetadata(uri);
      if (md && md.name) return md.name;
    } catch (_) {}
    return uri;
  }

  async function snapshotItems(playlistUri, items) {
    // items: array of { uri, uid }
    let contents = null;
    try {
      contents = await api.getContents(playlistUri);
    } catch (_) {}
    const byUid = {};
    const list = (contents && contents.items) || [];
    list.forEach((it, idx) => {
      if (it && it.uid) byUid[it.uid] = { it, idx };
    });

    const plName = await getPlaylistName(playlistUri);
    const now = Date.now();

    return items.map((target) => {
      const found = target.uid ? byUid[target.uid] : null;
      const it = found ? found.it : null;
      const trackUri = (it && it.uri) || target.uri || "";
      const name = (it && it.name) || trackUri;
      let artist = "";
      try {
        if (it && Array.isArray(it.artists)) artist = it.artists.map((a) => a.name).join(", ");
      } catch (_) {}
      return {
        id: now + "-" + Math.random().toString(36).slice(2, 8),
        playlistUri,
        playlistName: plName,
        uri: trackUri,
        uid: target.uid || null,
        name,
        artist,
        index: found ? found.idx : null,
        removedAt: now,
      };
    });
  }

  if (!api.__playlistUndoPatched && typeof api.remove === "function") {
    const origRemove = api.remove.bind(api);
    api.remove = function (playlistUri, items, ...rest) {
      // Fire-and-forget capture; never block or alter the real removal.
      try {
        if (typeof playlistUri === "string" && Array.isArray(items) && items.length) {
          snapshotItems(playlistUri, items)
            .then(addEntries)
            .catch((e) => console.error("[playlist-undo] capture failed", e));
        }
      } catch (e) {
        console.error("[playlist-undo] capture threw", e);
      }
      return origRemove(playlistUri, items, ...rest);
    };
    api.__playlistUndoPatched = true;
    console.log("[playlist-undo] watching playlist removals");
  }

  // ---------- restore ----------
  async function restore(entry) {
    try {
      // Best-effort: try to drop it back at its original index, else append.
      try {
        const opts = entry.index != null ? { before: { fromIndex: entry.index } } : {};
        await api.add(entry.playlistUri, [entry.uri], opts);
      } catch (_) {
        await api.add(entry.playlistUri, [entry.uri], {});
      }
      removeEntry(entry.id);
      S.showNotification('Restored "' + entry.name + '"');
      return true;
    } catch (e) {
      console.error("[playlist-undo] restore failed", e);
      S.showNotification("Restore failed — is the playlist still yours/editable?", true);
      return false;
    }
  }

  // ---------- UI ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
  function ago(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  const STYLE = `
    <style>
      #pu-wrap { font-size: 14px; color: var(--spice-text, #fff); }
      #pu-wrap .pu-head { opacity:.7; margin: 0 0 12px; }
      #pu-wrap .pu-list { max-height: 60vh; overflow-y: auto; }
      #pu-wrap .pu-row {
        display:flex; align-items:center; gap:12px;
        padding:8px 10px; border-radius:8px;
      }
      #pu-wrap .pu-row:hover { background: var(--spice-card, rgba(255,255,255,.07)); }
      #pu-wrap .pu-info { flex:1; min-width:0; }
      #pu-wrap .pu-track { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #pu-wrap .pu-sub { opacity:.6; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #pu-wrap button {
        cursor:pointer; border:none; border-radius:20px; padding:6px 14px;
        font-weight:700; font-size:13px;
      }
      #pu-wrap .pu-restore { background: var(--spice-button, #1ed760); color:#000; }
      #pu-wrap .pu-restore:hover { filter: brightness(1.08); }
      #pu-wrap .pu-dismiss { background: transparent; color: var(--spice-text,#fff); opacity:.5; padding:6px 10px; }
      #pu-wrap .pu-dismiss:hover { opacity:1; }
      #pu-wrap .pu-empty { opacity:.6; padding:40px 0; text-align:center; }
      #pu-wrap .pu-foot { margin-top:14px; display:flex; justify-content:flex-end; }
      #pu-wrap #pu-clear { background: transparent; color: var(--spice-text,#fff); opacity:.6; }
      #pu-wrap #pu-clear:hover { opacity:1; color:#f15e6c; }
    </style>`;

  function render(root) {
    const entries = load().slice().reverse(); // newest first
    let body;
    if (!entries.length) {
      body = '<div class="pu-empty">Nothing removed yet.<br>Tracks you delete from your playlists show up here.</div>';
    } else {
      body =
        '<div class="pu-list">' +
        entries
          .map(
            (e) =>
              '<div class="pu-row">' +
              '<div class="pu-info">' +
              '<div class="pu-track">' + esc(e.name) + "</div>" +
              '<div class="pu-sub">' +
              (e.artist ? esc(e.artist) + " · " : "") +
              esc(e.playlistName) + " · " + ago(e.removedAt) +
              "</div></div>" +
              '<div class="pu-actions">' +
              '<button class="pu-restore" data-id="' + e.id + '">Restore</button>' +
              '<button class="pu-dismiss" data-id="' + e.id + '" title="Forget this">✕</button>' +
              "</div></div>"
          )
          .join("") +
        "</div>" +
        '<div class="pu-foot"><button id="pu-clear">Clear all</button></div>';
    }

    root.innerHTML =
      STYLE +
      '<div id="pu-wrap"><p class="pu-head">Restore tracks you removed from your playlists. Position is best-effort.</p>' +
      body +
      "</div>";

    root.querySelectorAll(".pu-restore").forEach((b) => {
      b.onclick = async () => {
        const e = load().find((x) => x.id === b.dataset.id);
        if (e) {
          b.textContent = "…";
          await restore(e);
          render(root);
        }
      };
    });
    root.querySelectorAll(".pu-dismiss").forEach((b) => {
      b.onclick = () => {
        removeEntry(b.dataset.id);
        render(root);
      };
    });
    const clr = root.querySelector("#pu-clear");
    if (clr) clr.onclick = () => { clearAll(); render(root); };
  }

  function openModal() {
    const root = document.createElement("div");
    render(root);
    S.PopupModal.display({ title: "Playlist Undo", content: root, isLarge: true });
  }

  new S.Topbar.Button("Playlist Undo", "skip-back", openModal);
})();
