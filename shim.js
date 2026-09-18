// Spotbuch Web: stellt der App dieselbe Schnittstelle bereit wie die Claude-Version
// (window.claude.use('db' | 'assets' | 'sample' | 'user')), spricht aber mit der
// Supabase Edge Function aus config.js. Dazu: Einrichtung (Name + Crew-Code),
// Einladen per WhatsApp und Offline-Cache.
(() => {
  const API = window.SPOTBUCH_API || '';
  const LS = {
    get(k){ try { return localStorage.getItem('spotbuch.' + k) || ''; } catch { return ''; } },
    set(k, v){ try { localStorage.setItem('spotbuch.' + k, v); } catch {} },
  };

  // Crew-Code aus dem Einladungslink (?crew=...) übernehmen
  const urlCrew = new URLSearchParams(location.search).get('crew');
  if (urlCrew) LS.set('crew', urlCrew.trim());
  // Die Spieler-Kennung kommt aus dem Namen: Auf dem iPhone haben Safari und das Home-Bildschirm-Symbol
  // getrennten Speicher, mit demselben Namen bleibst du trotzdem derselbe Spieler.
  const slug = n => (n || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '') || 'spieler';
  const me = () => ({id: 'n_' + slug(LS.get('name')), name: LS.get('name')});

  class ApiError { constructor(code, status){ this.code = code; this.status = status; this.message = code; } }
  async function api(action, payload = {}){
    let res;
    try {
      res = await fetch(API, {method: 'POST', headers: {'content-type': 'application/json', 'x-crew': LS.get('crew')},
        body: JSON.stringify({action, ...payload})});
    } catch { throw new ApiError('offline', 0); }
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new ApiError(body.error || 'upstream_error', res.status);
    return body;
  }

  // ---------- Bilder ----------
  async function toJpegB64(blob, max){
    let src, w, h, done = () => {};
    try { src = await createImageBitmap(blob); w = src.width; h = src.height; done = () => src.close?.(); }
    catch {
      const url = URL.createObjectURL(blob);
      src = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight; done = () => URL.revokeObjectURL(url);
    }
    const k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); done();
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  // ---------- Spots (Polling statt Live-Verbindung) ----------
  let spots = [], listeners = [], timer = null, failed = false;
  async function refresh(){
    try {
      spots = (await api('list')).spots || [];
      failed = false;
      const snap = {docs: spots.map(s => ({id: s.id, data: () => s}))};
      listeners.forEach(l => l.next(snap));
    } catch (e) {
      if (!failed) listeners.forEach(l => l.error?.(e));
      failed = true;
    }
  }
  function startPolling(){
    if (timer) return;
    refresh();
    timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }
  const query = {
    orderBy(){ return query; }, limit(){ return query; },
    onSnapshot(next, error){ listeners.push({next, error}); startPolling(); return () => {}; },
    async add(doc){
      const r = await api('save', {spot: {...doc, byName: me().name}});
      await refresh();
      return {id: r.id};
    },
  };
  const db = {
    collection: () => query,
    doc: path => ({ async delete(){ await api('delete', {id: path.split('/')[1], by: me().id}); await refresh(); } }),
  };

  const assets = {
    async upload(blob){ const {url} = await api('upload', {image: await toJpegB64(blob, 1600)}); return {id: url, url}; },
    async delete(){ return {deleted: true}; }, // Fotos löscht der Server zusammen mit dem Spot
  };

  const sample = Object.assign(async () => { throw new ApiError('capability_removed'); }, {
    limits: async () => ({maxPromptBytes: 60000, images: {maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp']}}),
    async json(prompt, opts = {}){
      const images = await Promise.all([...(opts.images || [])].map(b => toJpegB64(b, 1280)));
      if (opts.signal?.aborted) throw new ApiError('cancelled');
      const job = api('scan', {prompt, images}).then(r => r.result);
      if (!opts.signal) return job;
      return Promise.race([job, new Promise((_, no) => opts.signal.addEventListener('abort', () => no(new ApiError('cancelled'))))]);
    },
  });

  // Namen kommen aus den Spots selbst (jeder Spot speichert "byName")
  function initials(name, color){
    const t = (name || '?').trim().slice(0, 1).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="${color}"/><text x="20" y="26" font-family="Arial" font-weight="700" font-size="18" fill="#fff" text-anchor="middle">${t.replace(/[<&"]/g, '')}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  const COLORS = ['#e8501a', '#1f56c4', '#1f8a4c', '#8b3fd1', '#c2372b', '#b7791f'];
  function profile(id){
    const mine = id === me().id;
    const name = mine ? me().name : (spots.find(s => s.by === id && s.byName)?.byName || '');
    let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const color = COLORS[h % COLORS.length];
    return {id, name, avatarUrl: initials(name, color), color, email: null, isMe: mine};
  }
  const user = {
    async me(){ const p = profile(me().id); return {...p, isOwner: false, canEdit: true}; },
    async id(){ return me().id; },
    async profiles(ids){ const out = {}; for (const id of [].concat(ids)) out[id] = profile(id); return out; },
    async isOwner(){ return false; }, async canEdit(){ return true; }, async can(){ return true; },
  };

  // ---------- Einrichtung: Name + Crew-Code ----------
  function setupSheet(){
    return new Promise(resolve => {
      const el = document.createElement('section');
      el.className = 'sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
      el.innerHTML = `<div class="sheet-in">
        <div class="sheet-bar"><h2>Willkommen</h2></div>
        <p class="hint">Das Spotbuch ist eure gemeinsame Carspotting-App. Gib deinen Namen ein, damit dein Kumpel sieht, wer was gespottet hat. Nimm überall denselben Namen, dann bleiben deine Punkte deine.</p>
        <div class="field"><label for="setupName">Dein Name</label><input id="setupName" type="text" maxlength="20" autocomplete="nickname" placeholder="z. B. Ben"></div>
        <div class="field"><label for="setupCrew">Crew-Code</label><input id="setupCrew" type="text" maxlength="40" autocomplete="off" autocapitalize="characters" placeholder="steht im Einladungslink"></div>
        <div class="msg err" id="setupErr" hidden></div>
        <button class="btn primary block" id="setupGo" type="button">Los geht’s</button>
        <p class="fine">Tipp fürs iPhone: In Safari auf „Teilen“ und dann „Zum Home-Bildschirm“ tippen. Dann startet das Spotbuch wie eine App.</p>
      </div>`;
      document.body.append(el);
      const name = el.querySelector('#setupName'), crew = el.querySelector('#setupCrew'), err = el.querySelector('#setupErr');
      name.value = LS.get('name'); crew.value = LS.get('crew');
      (LS.get('crew') ? name : crew).focus();
      el.querySelector('#setupGo').onclick = async () => {
        err.hidden = true;
        if (!name.value.trim()) { err.textContent = 'Gib deinen Namen ein.'; err.hidden = false; return; }
        LS.set('name', name.value.trim().slice(0, 20)); LS.set('crew', crew.value.trim());
        try { await api('list'); }
        catch (e) {
          err.textContent = e.code === 'crew' ? 'Der Crew-Code stimmt nicht. Frag deinen Kumpel nach dem Einladungslink.'
            : 'Keine Verbindung zum Server. Prüf dein Internet und versuch es nochmal.';
          err.hidden = false; return;
        }
        el.remove(); resolve();
      };
    });
  }
  let ready = null;
  function ensureSetup(){
    if (!ready) ready = (LS.get('name') && LS.get('crew')) ? Promise.resolve() : setupSheet();
    return ready;
  }

  // ---------- Einladen ----------
  function inviteUrl(){ const u = new URL(location.href); u.search = '?crew=' + encodeURIComponent(LS.get('crew')); u.hash = ''; return u.toString(); }
  async function invite(){
    const url = inviteUrl(), text = 'Komm ins Spotbuch! Wir spotten Autos um die Wette:';
    try { if (navigator.share) { await navigator.share({title: 'Spotbuch', text, url}); return; } } catch { return; }
    location.href = 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const top = document.querySelector('.top');
    if (!top) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = 'Einladen';
    b.onclick = invite;
    top.append(b);
  });

  if (!API) { window.claude = {use: async () => null}; return; }
  window.claude = {
    async use(name){
      await ensureSetup();
      return {db, assets, sample, user}[name] || null;
    },
  };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
