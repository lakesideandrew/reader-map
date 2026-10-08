// Reader Map — front end. Plain JS + Leaflet, no build step.
// Reads the JSON files in web/data/ that the weekly jobs keep current.
(function () {
  "use strict";

  const CFG = window.READER_MAP;
  const STATUS_ORDER = ["active", "other_vendor", "pending", "cancelled", "none", "unknown"];
  const STATUS = {
    active: { label: "Active Flock contract", short: "Active (Flock)" },
    other_vendor: { label: "Active, non-Flock ALPR", short: "Other vendor" },
    pending: { label: "Pending cancellation / suspended", short: "Pending" },
    cancelled: { label: "Cancelled / cameras removed", short: "Cancelled" },
    none: { label: "No ALPR cameras", short: "No ALPR" },
    unknown: { label: "Not yet confirmed", short: "Unknown" },
  };
  const BY_LABEL = {
    seed: "Initial research",
    ai: "Weekly news check, auto-applied",
    manual: "Editor review",
    "osm-refresh": "OpenStreetMap refresh",
  };

  const D = {}; // loaded data
  const state = {
    statuses: new Set(STATUS_ORDER),
    county: "",
    q: "",
    cameras: true,
    inherit: true,
    townships: true,
    restricted: false,
    selected: null,
  };

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = (status) => cssVar(`--s-${status}`);
  const byLabel = (h) => (BY_LABEL[h.by] || h.by) + (h.corrected ? `, corrected by editor ${fmtDate(h.corrected)}` : "");
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  };
  const num = (n) => (n == null ? "" : Number(n).toLocaleString("en-US"));

  async function getJson(path, fallback) {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      if (fallback !== undefined) return fallback;
      throw e;
    }
  }

  // Status a city shows on the map. Cities without their own known status
  // inherit from the agency that polices them (county sheriff, etc.).
  function effective(c) {
    if (c.status !== "unknown" || !state.inherit) return { status: c.status, inherited: false, via: null };
    for (const id of c.covered_by || []) {
      const a = D.agencies[id];
      if (a && a.status !== "unknown") return { status: a.status, inherited: true, via: a };
    }
    return { status: "unknown", inherited: false, via: null };
  }

  function sheriffOf(county) {
    return D.agencies[`${county.toLowerCase().replace(/\s+/g, "-")}-sheriff`];
  }

  function passesNonStatus(c) {
    if (!state.townships && c.kind !== "city") return false;
    if (state.county && !c.counties.includes(state.county)) return false;
    if (state.q && !c.name.toLowerCase().includes(state.q)) return false;
    if (state.restricted) {
      const e = effective(c);
      if (!(c.sharing_restricted || (e.via && e.via.sharing_restricted))) return false;
    }
    return true;
  }
  const passes = (c) => passesNonStatus(c) && state.statuses.has(effective(c).status);

  function camCounts(id) {
    const c = D.camsByCity.cities[id];
    if (!c) return { total: 0, flock: 0 };
    return { total: c.total, flock: c.vendors.flock || 0, vendors: c.vendors, operators: c.operators };
  }

  // ---------- map ----------
  let map, tiles, labelTiles, cityLayer, camLayer, radiusCircle;
  const camRenderer = L.canvas({ padding: 0.5 });

  // Esri gray canvas: keyless, made for thematic maps. Labels sit in their
  // own pane above the city fills so names stay readable.
  function tileUrls() {
    const shade = document.documentElement.getAttribute("data-theme") === "dark" ? "Dark" : "Light";
    const base = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
    return {
      base: `${base}/World_${shade}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      labels: `${base}/World_${shade}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    };
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, minZoom: 8, maxZoom: 18 }).setView(CFG.center, CFG.zoom);
    map.createPane("labels");
    map.getPane("labels").style.zIndex = 450;
    map.getPane("labels").style.pointerEvents = "none";
    const urls = tileUrls();
    tiles = L.tileLayer(urls.base, {
      maxZoom: 16,
      maxNativeZoom: 16,
      attribution:
        'Camera data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL) · Basemap &copy; Esri, HERE, Garmin, OpenStreetMap · Boundaries: MnDOT',
    }).addTo(map);
    labelTiles = L.tileLayer(urls.labels, { pane: "labels", maxZoom: 18, maxNativeZoom: 16 }).addTo(map);

    radiusCircle = L.circle(CFG.center, {
      radius: CFG.radiusMiles * 1609.344,
      color: cssVar("--muted"),
      weight: 1.2,
      dashArray: "6 6",
      fill: false,
      interactive: false,
    }).addTo(map);
    if (!location.hash.startsWith("#/city/")) map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });

    cityLayer = L.geoJSON(D.boundaries, {
      style: cityStyle,
      onEachFeature: (f, layer) => {
        layer.on("click", () => select(f.id, { pan: false }));
        layer.bindTooltip(() => tipHtml(f.id), { sticky: true, className: "city-tip", direction: "top", offset: [0, -6] });
        layer.on("mouseover", () => layer.setStyle({ weight: 2.5 }));
        layer.on("mouseout", () => cityLayer.resetStyle(layer));
      },
    }).addTo(map);

    camLayer = L.layerGroup();
    for (const f of D.cameras.features) {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties;
      L.circleMarker([lat, lng], {
        renderer: camRenderer,
        radius: 3,
        weight: 1,
        color: cssVar("--bg"),
        fillColor: p.vendor === "flock" ? cssVar("--cam-flock") : cssVar("--cam-other"),
        fillOpacity: 0.95,
        vendor: p.vendor,
      })
        .bindPopup(camPopup(p))
        .addTo(camLayer);
    }
    if (state.cameras) camLayer.addTo(map);
    map.on("zoomend", sizeCameras);
    sizeCameras();
  }

  function sizeCameras() {
    const r = map.getZoom() >= 13 ? 5 : map.getZoom() >= 11 ? 3.5 : 2.5;
    camLayer.eachLayer((m) => m.setRadius(r));
  }

  function cityStyle(f) {
    const c = D.cities[f.id];
    const e = effective(c);
    const on = passes(c);
    const sel = state.selected === f.id;
    if (!on) {
      return { color: cssVar("--map-line"), weight: 0.5, opacity: 0.35, fillColor: color("unknown"), fillOpacity: 0.03, dashArray: null };
    }
    const fill = color(e.status);
    return {
      color: sel ? cssVar("--accent") : e.inherited ? fill : cssVar("--map-line"),
      weight: sel ? 3 : e.inherited ? 1.2 : 0.8,
      opacity: sel ? 1 : 0.8,
      dashArray: e.inherited && !sel ? "4 4" : null,
      fillColor: fill,
      fillOpacity: e.inherited ? 0.17 : e.status === "unknown" ? 0.1 : 0.45,
    };
  }

  function tipHtml(id) {
    const c = D.cities[id];
    const e = effective(c);
    const via = e.inherited ? ` <span class="muted">via ${esc(e.via.name)}</span>` : "";
    return `<b>${esc(c.name)}</b><span class="swatch" style="display:inline-block;vertical-align:-1px;margin-right:5px;background:${color(e.status)}"></span>${esc(STATUS[e.status].short)}${via}`;
  }

  function camPopup(p) {
    const vendor = p.manufacturer || (p.vendor === "unknown" ? "Unknown manufacturer" : p.vendor);
    const rows = [
      ["Operator", p.operator || "Not tagged"],
      ["Facing", p.direction ? `${p.direction}°` : null],
      ["Mount", p.mount],
      ["Last checked", p.checked],
    ]
      .filter((r) => r[1])
      .map((r) => `<div><span class="muted">${r[0]}:</span> ${esc(r[1])}</div>`)
      .join("");
    return `<div style="font-size:12.5px"><b>${esc(vendor)}</b> plate reader${rows}<div style="margin-top:4px"><a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">View on OpenStreetMap</a></div></div>`;
  }

  function restyle() {
    cityLayer.setStyle(cityStyle);
    radiusCircle.setStyle({ color: cssVar("--muted") });
    camLayer.eachLayer((m) =>
      m.setStyle({ color: cssVar("--bg"), fillColor: m.options.vendor === "flock" ? cssVar("--cam-flock") : cssVar("--cam-other") }),
    );
  }

  // ---------- sidebar ----------
  function renderChips() {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    let total = 0;
    for (const c of Object.values(D.cities)) {
      if (!passesNonStatus(c)) continue;
      counts[effective(c).status]++;
      total++;
    }
    $("#city-total").textContent = `${total} shown`;
    $("#status-chips").innerHTML = STATUS_ORDER.map(
      (s) =>
        `<button type="button" class="chip${state.statuses.has(s) ? "" : " off"}" data-s="${s}" aria-pressed="${state.statuses.has(s)}">
           <span class="swatch" style="background:${color(s)}"></span>${esc(STATUS[s].short)}<span class="n">${counts[s]}</span>
         </button>`,
    ).join("");
  }

  function renderList() {
    const rows = Object.values(D.cities)
      .filter(passes)
      .map((c) => ({ c, e: effective(c) }))
      .sort((a, b) => STATUS_ORDER.indexOf(a.e.status) - STATUS_ORDER.indexOf(b.e.status) || a.c.name.localeCompare(b.c.name));
    $("#list-count").textContent = rows.length;
    $("#city-list").innerHTML = rows
      .map(({ c, e }) => {
        const cams = c.cameras_reported != null ? `${c.cameras_reported} cams` : "";
        const dot = e.inherited
          ? `<span class="dot inherited" style="border-color:${color(e.status)}" title="Inherited from ${esc(e.via.name)}"></span>`
          : `<span class="dot" style="background:${color(e.status)}"></span>`;
        return `<li data-id="${esc(c.id)}" class="${state.selected === c.id ? "sel" : ""}">${dot}<span class="nm">${esc(c.name)}</span><span class="tag">${esc(cams)}</span></li>`;
      })
      .join("");
  }

  function renderSideFoot() {
    const m = D.meta;
    const parts = [];
    if (m.aiCheckedAt) parts.push(`News checked ${fmtDate(m.aiCheckedAt)}`);
    if (m.camerasFetchedAt) parts.push(`cameras refreshed ${fmtDate(m.camerasFetchedAt)}`);
    $("#side-foot").textContent = parts.length ? parts.join(" · ") : "";
  }

  function refresh() {
    renderChips();
    renderList();
    cityLayer.setStyle(cityStyle);
  }

  // ---------- legend ----------
  function renderLegend() {
    $("#legend").innerHTML =
      `<button type="button" class="legend-head" id="legend-toggle" aria-expanded="true">Legend<span class="chev">▾</span></button>` +
      STATUS_ORDER.map((s) => `<div class="lg"><span class="swatch" style="background:${color(s)}"></span>${esc(STATUS[s].label)}</div>`).join("") +
      `<div class="sep extra"></div>
       <div class="lg extra"><span class="hatch"></span>Lighter, dashed: inherited from county sheriff or contract police</div>
       <div class="lg extra"><span class="cam" style="background:${cssVar("--cam-flock")}"></span>Flock camera <span class="cam" style="background:${cssVar("--cam-other")}"></span>Other vendor</div>`;
  }

  // ---------- detail ----------
  function statusBadge(status, extra) {
    return `<span class="badge"><span class="swatch" style="background:${color(status)}"></span>${esc(STATUS[status].label)}${extra || ""}</span>`;
  }

  function sourcesHtml(sources) {
    if (!sources || !sources.length) return `<p class="muted">No sources recorded yet.</p>`;
    return `<ol class="sources">${sources
      .map((s) => {
        const u = safeUrl(s.url);
        const title = esc(s.title || s.url);
        const meta = [s.outlet, fmtDate(s.date)].filter(Boolean).map(esc).join(" · ");
        return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${title}</a>` : title}${meta ? `<div class="meta">${meta}</div>` : ""}</li>`;
      })
      .join("")}</ol>`;
  }

  function agencyCard(a, why) {
    const st = a.status;
    const cams = a.cameras ? ` · ${a.cameras} cameras` : "";
    const src = a.sources && a.sources[0] && safeUrl(a.sources[0].url);
    return `<div class="card"><div class="head"><span class="swatch" style="background:${color(st)}"></span>${esc(a.name)}</div>
      <div class="muted">${esc(STATUS[st].label)}${esc(cams)}${why ? ` · ${esc(why)}` : ""}</div>
      ${a.summary ? `<div style="margin-top:4px">${esc(a.summary)}</div>` : ""}
      ${src ? `<div style="margin-top:4px"><a href="${esc(src)}" target="_blank" rel="noopener">Source</a></div>` : ""}</div>`;
  }

  function renderDetail() {
    const el = $("#detail");
    const c = state.selected && D.cities[state.selected];
    if (!c) {
      el.hidden = true;
      return;
    }
    const e = effective(c);
    const cams = camCounts(c.id);
    const kind = c.kind === "city" ? "City" : c.kind === "township" ? "Township" : "Unorganized territory";
    const sub = [kind, c.counties.map((x) => `${x} County`).join(" / "), c.population ? `pop. ${num(c.population)}` : ""].filter(Boolean).join(" · ");

    const badges = [statusBadge(e.status, e.inherited ? ` <span class="muted">via ${esc(e.via.name)}</span>` : "")];
    if (c.sharing_restricted) badges.push(`<span class="badge">Data sharing restricted</span>`);
    if (c.confidence === "low") badges.push(`<span class="badge warn">Low confidence</span>`);

    const notes = [];
    if ((e.status === "cancelled" || e.status === "none") && !e.inherited && cams.flock > 0)
      notes.push(
        `${cams.flock} Flock camera${cams.flock === 1 ? " is" : "s are"} still mapped here in OpenStreetMap. Volunteer maps can lag removals, and some mapped cameras belong to other agencies, such as the county sheriff, or to private operators such as retailers or HOAs.`,
      );
    if (e.status === "unknown" && cams.total > 0)
      notes.push(`${cams.total} plate reader${cams.total === 1 ? " is" : "s are"} mapped here in OpenStreetMap, but who operates them is not confirmed.`);
    if (e.inherited)
      notes.push(`${c.name} has no status of its own on record. It is shown with the status of ${e.via.name}, which provides its policing.`);

    const facts = [
      ["Vendor", c.vendor],
      ["Cameras reported", c.cameras_reported != null ? num(c.cameras_reported) : null],
      [
        "Mapped in OSM",
        cams.total
          ? `${cams.total}${cams.flock ? ` (${cams.flock} Flock)` : ""}`
          : "0",
      ],
      ["Status since", fmtDate(c.since)],
      ["Confidence", c.confidence],
      ["Last reviewed", fmtDate(c.last_reviewed)],
      ["Last news check", fmtDate(c.last_ai_check)],
    ].filter((r) => r[1]);

    // Agencies relevant to this place: contract police, the county
    // sheriff(s), and any agency listing this city (U of M, airport).
    const seen = new Set();
    const cards = [];
    for (const id of c.covered_by || []) {
      const a = D.agencies[id];
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        cards.push(agencyCard(a, "provides policing"));
      }
    }
    for (const county of c.counties) {
      const a = sheriffOf(county);
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        cards.push(agencyCard(a, "countywide"));
      }
    }
    const bare = c.name.replace(/ Twp$/, "");
    for (const a of Object.values(D.agencies))
      if (!seen.has(a.id) && (a.cities || []).includes(bare)) {
        seen.add(a.id);
        cards.push(agencyCard(a, "operates here"));
      }

    const hist = D.history
      .filter((h) => h.city === c.id)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 12);

    const issueUrl = `https://github.com/${CFG.repo}/issues/new?title=${encodeURIComponent(`Correction: ${c.name}`)}&body=${encodeURIComponent(
      `City: ${c.name} (id ${c.id})\nCurrent status on map: ${STATUS[e.status].label}\n\nWhat should change, with a source link:\n`,
    )}`;

    el.innerHTML = `
      <button type="button" class="icon-btn close" id="detail-close" aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
      </button>
      <h2>${esc(c.name)}</h2>
      <div class="sub">${esc(sub)}</div>
      <div class="badges">${badges.join("")}</div>
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
      ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <h3>Sources</h3>
      ${sourcesHtml(c.sources)}
      ${cards.length ? `<h3>Other agencies here</h3>${cards.join("")}` : ""}
      ${
        hist.length
          ? `<h3>History</h3><ul class="timeline">${hist
              .map((h) => `<li><div class="d">${esc(fmtDate(h.date))} · ${esc(byLabel(h))}</div>${esc(h.summary)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <a class="correction" href="${esc(issueUrl)}" target="_blank" rel="noopener">Report a correction</a>`;
    el.hidden = false;
    el.scrollTop = 0;
    $("#detail-close").onclick = () => select(null);
  }

  function select(id, { pan = true } = {}) {
    state.selected = id && D.cities[id] ? id : null;
    renderDetail();
    renderList();
    cityLayer.setStyle(cityStyle);
    const hash = state.selected ? `#/city/${state.selected}` : "#/map";
    if (location.hash !== hash) history.replaceState(null, "", hash);
    if (state.selected && pan) {
      const layer = cityLayer.getLayers().find((l) => l.feature.id === state.selected);
      if (layer) map.fitBounds(layer.getBounds(), { maxZoom: 12, paddingBottomRight: window.innerWidth > 820 ? [400, 0] : [0, 0], paddingTopLeft: [20, 20] });
    }
    $("#backdrop").hidden = !(window.innerWidth <= 820 && (state.selected || $("#sidebar").classList.contains("open")));
  }

  // ---------- changes page ----------
  function placeName(h) {
    if (h.city && D.cities[h.city]) return { name: D.cities[h.city].name, href: `#/city/${h.city}` };
    if (h.agency && D.agencies[h.agency]) return { name: D.agencies[h.agency].name, href: null };
    return { name: h.city || h.agency || "Unknown", href: null };
  }

  function pill(status) {
    if (!status || !STATUS[status]) return "";
    return `<span class="pill"><span class="swatch" style="background:${color(status)}"></span>${esc(STATUS[status].short)}</span>`;
  }

  function renderChanges() {
    const showOsm = $("#t-show-osm").checked;
    const items = D.history
      .filter((h) => showOsm || h.type !== "cameras")
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    let html = "";
    let month = "";
    for (const h of items) {
      const m = new Date(h.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
      if (m !== month) {
        html += `<div class="month">${esc(m)}</div>`;
        month = m;
      }
      const p = placeName(h);
      const title = p.href ? `<a href="${p.href}">${esc(p.name)}</a>` : esc(p.name);
      const change =
        h.type === "status"
          ? h.from && h.from !== h.to
            ? `${pill(h.from)} <span class="muted">→</span> ${pill(h.to)}`
            : pill(h.to)
          : `<span class="pill">${esc(h.from)} → ${esc(h.to)} mapped cameras</span>`;
      const src = safeUrl(h.source);
      html += `<div class="entry"><div class="d">${esc(fmtDate(h.date))}</div><div>
        <div class="t">${title} ${change}</div>
        <div class="s">${esc(h.summary)}${src ? ` <a href="${esc(src)}" target="_blank" rel="noopener">Source</a>` : ""}</div>
        <div class="by">${esc(byLabel(h))}</div></div></div>`;
    }
    $("#feed").innerHTML = html || `<p class="muted">No changes recorded yet.</p>`;

    const pending = (D.proposals || []).filter((p) => p.state === "open" && p.public !== false);
    $("#proposals").innerHTML = pending.length
      ? `<div class="review-box"><div class="side-label" style="margin-bottom:6px">Awaiting editor review (${pending.length})</div>
          <p class="muted" style="margin:0 0 8px;font-size:13px">Possible changes the weekly news check found but did not apply, usually because the source was not a recognized outlet or the evidence was not conclusive.</p>
          ${pending
            .map((p) => {
              const n = placeName(p);
              const src = safeUrl(p.url);
              return `<div class="entry"><div class="d">${esc(fmtDate(p.found))}</div><div><div class="t">${n.href ? `<a href="${n.href}">${esc(n.name)}</a>` : esc(n.name)} ${pill(p.proposed_status)}</div>
                <div class="s">${esc(p.evidence)}${src ? ` <a href="${esc(src)}" target="_blank" rel="noopener">Source</a>` : ""}</div></div></div>`;
            })
            .join("")}</div>`
      : "";
  }

  function renderChangesBadge() {
    const cutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const n = D.history.filter((h) => h.type === "status" && h.date >= cutoff && h.by !== "seed").length;
    const b = $("#changes-badge");
    b.textContent = n;
    b.hidden = n === 0;
  }

  // ---------- about page ----------
  function renderAbout() {
    const m = D.meta;
    $("#about").innerHTML = `
      <h1>About Reader Map</h1>
      <p class="lede">Reader Map tracks which cities within ${CFG.radiusMiles} miles of downtown Minneapolis use automated license plate reader (ALPR) cameras, mostly from Flock Safety, and which have paused or cancelled them.</p>

      <h2>What the colors mean</h2>
      <table class="status-table">
        <tr><td>${pill("active")}</td><td>The city has a Flock Safety contract in force and cameras operating. Cities that kept cameras but restricted outside-agency or immigration searches carry a "Data sharing restricted" note.</td></tr>
        <tr><td>${pill("other_vendor")}</td><td>The city runs plate readers from another vendor, such as Motorola, Axon or Insight LPR. Shaded a step lighter than Flock.</td></tr>
        <tr><td>${pill("pending")}</td><td>A cancellation has been voted or announced but not finished, or the contract is suspended, or cameras are offline pending an audit.</td></tr>
        <tr><td>${pill("cancelled")}</td><td>The contract has ended, or the cameras have been removed or are non-functional.</td></tr>
        <tr><td>${pill("none")}</td><td>The city has stated that it uses no plate reader cameras.</td></tr>
        <tr><td>${pill("unknown")}</td><td>Not yet confirmed. Most of these are being worked through by the weekly news check.</td></tr>
      </table>
      <p>Many smaller cities and every township have no police department of their own. They are policed by the county sheriff or a neighboring department under contract. When such a place has no status of its own, the map shows the status of the agency that polices it, in a lighter shade with a dashed outline. County sheriffs in Hennepin, Ramsey, Anoka and Dakota counties all operate Flock cameras countywide, including inside cities that have cancelled their own.</p>

      <h2>How it stays current</h2>
      <ul>
        <li><b>Camera locations</b> are refreshed weekly from OpenStreetMap, where volunteers, including the DeFlock project, map plate reader cameras. ${m.camerasFetchedAt ? `Last refresh: ${esc(fmtDate(m.camerasFetchedAt))}, ${num(m.cameraCount)} cameras.` : ""}</li>
        <li><b>City statuses</b> are checked weekly by an automated news search using Claude. A change is applied automatically only when the evidence is conclusive, recent, and from a recognized news outlet or a government website. Everything else waits for a human editor. ${m.aiCheckedAt ? `Last check: ${esc(fmtDate(m.aiCheckedAt))}.` : ""}</li>
        <li><b>Every change</b> is logged on the <a href="#/changes">Changes</a> page with its source.</li>
      </ul>

      <h2>Limits</h2>
      <ul>
        <li>OpenStreetMap includes cameras run by private businesses, HOAs and retailers, not only police. Its counts can be far higher or lower than a city's reported count, and it can lag removals.</li>
        <li>Statuses rely on public reporting. A city with no news coverage may stay "unknown" for a while.</li>
        <li>Wisconsin cities inside the circle are not included yet.</li>
      </ul>

      <h2>Sources and licenses</h2>
      <ul>
        <li>Camera data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, available under the Open Database License. Mapping effort by <a href="https://deflock.org">DeFlock</a> and many local volunteers.</li>
        <li>City and township boundaries: <a href="https://gis.data.mn.gov/datasets/mndot::city-township-and-unorganized-territory-in-minnesota">MnDOT, City, Township and Unorganized Territory</a>.</li>
        <li>Lakes and rivers: <a href="https://gis.data.mn.gov">Minnesota DNR Hydrography</a>, cut out of the city shapes so shading stops at the shoreline.</li>
        <li>Reported camera counts: the <a href="https://www.mnprivacy.org/tracker/">mnprivacy.org tracker</a>, built from state-required agency reports, plus news coverage linked on each city.</li>
        <li>Basemap © <a href="https://carto.com/attributions">CARTO</a>.</li>
      </ul>

      <h2>Corrections</h2>
      <p>Spotted something wrong or out of date? <a href="https://github.com/${esc(CFG.repo)}/issues/new?title=Correction" target="_blank" rel="noopener">Open a correction</a> with a link to a source.</p>`;
  }

  // ---------- routing ----------
  function route() {
    const h = location.hash || "#/map";
    const [, page, arg] = h.split("/");
    const name = ["map", "changes", "about", "city"].includes(page) ? page : "map";
    const pageId = name === "city" ? "map" : name;
    for (const p of ["map", "changes", "about"]) $(`#page-${p}`).hidden = p !== pageId;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.route === pageId));
    if (pageId === "map") {
      map.invalidateSize();
      if (name === "city" && arg && arg !== state.selected) select(decodeURIComponent(arg));
    }
    if (pageId === "changes") renderChanges();
  }

  // ---------- wiring ----------
  function wire() {
    $("#status-chips").addEventListener("click", (ev) => {
      const b = ev.target.closest(".chip");
      if (!b) return;
      const s = b.dataset.s;
      if (state.statuses.size === STATUS_ORDER.length) state.statuses = new Set([s]);
      else if (state.statuses.has(s)) state.statuses.delete(s);
      else state.statuses.add(s);
      if (state.statuses.size === 0) state.statuses = new Set(STATUS_ORDER);
      refresh();
    });
    $("#search").addEventListener("input", (ev) => {
      state.q = ev.target.value.trim().toLowerCase();
      refresh();
    });
    $("#county").addEventListener("change", (ev) => {
      state.county = ev.target.value;
      refresh();
    });
    $("#t-cameras").addEventListener("change", (ev) => {
      state.cameras = ev.target.checked;
      state.cameras ? camLayer.addTo(map) : camLayer.remove();
    });
    for (const [id, key] of [["#t-inherit", "inherit"], ["#t-townships", "townships"], ["#t-restricted", "restricted"]])
      $(id).addEventListener("change", (ev) => {
        state[key] = ev.target.checked;
        refresh();
        renderDetail();
      });
    $("#city-list").addEventListener("click", (ev) => {
      const li = ev.target.closest("li");
      if (!li) return;
      select(li.dataset.id);
      if (window.innerWidth <= 820) toggleSidebar(false);
    });
    $("#t-show-osm").addEventListener("change", renderChanges);
    $("#theme-btn").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light-paper" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("readerMapTheme", next);
      } catch (e) {}
      const urls = tileUrls();
      tiles.setUrl(urls.base);
      labelTiles.setUrl(urls.labels);
      restyle();
      renderChips();
      renderList();
      renderLegend();
      renderDetail();
      if (!$("#page-changes").hidden) renderChanges();
      renderAbout();
    });
    $("#menu-btn").addEventListener("click", () => toggleSidebar(!$("#sidebar").classList.contains("open")));
    $("#backdrop").addEventListener("click", () => {
      toggleSidebar(false);
      select(null);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.selected) select(null);
    });
    window.addEventListener("hashchange", route);
  }

  function toggleSidebar(open) {
    $("#sidebar").classList.toggle("open", open);
    $("#menu-btn").setAttribute("aria-expanded", String(open));
    $("#backdrop").hidden = !(window.innerWidth <= 820 && (open || state.selected));
    if (open && $("#page-map").hidden) location.hash = "#/map";
  }

  async function main() {
    const [boundaries, cities, agencies, cameras, camsByCity, history, proposals, meta] = await Promise.all([
      // Shapes with lakes and rivers cut out; full boundaries as a fallback.
      getJson("data/boundaries-land.geojson", null).then((d) => d || getJson("data/boundaries.geojson")),
      getJson("data/cities.json"),
      getJson("data/agencies.json"),
      getJson("data/cameras.geojson", { type: "FeatureCollection", features: [] }),
      getJson("data/cameras-by-city.json", { cities: {} }),
      getJson("data/history.json", []),
      getJson("data/proposals.json", []),
      getJson("data/meta.json", {}),
    ]);
    Object.assign(D, { boundaries, cities, agencies, cameras, camsByCity, history, proposals, meta });

    const counties = [...new Set(Object.values(cities).flatMap((c) => c.counties))].sort();
    $("#county").insertAdjacentHTML("beforeend", counties.map((c) => `<option>${esc(c)}</option>`).join(""));
    if (window.innerWidth <= 820) $("#legend").classList.add("collapsed");
    $("#legend").addEventListener("click", (ev) => {
      if (!ev.target.closest("#legend-toggle")) return;
      const collapsed = $("#legend").classList.toggle("collapsed");
      ev.target.closest("#legend-toggle").setAttribute("aria-expanded", String(!collapsed));
    });

    initMap();
    wire();
    renderLegend();
    renderSideFoot();
    renderChangesBadge();
    renderAbout();
    refresh();
    route();
  }

  main().catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div style="position:fixed;inset:auto 16px 16px;padding:12px 14px;background:#7f1d1d;color:#fff;border-radius:8px;z-index:2000">Could not load map data. ${esc(e.message)}</div>`,
    );
  });
})();
