import React, { useEffect, useRef, useState } from "react";
import { ipv4Network } from "../firewallConfig.mjs";
import "./inventory.css";

export default function LocalDiscovery({ onClose, onReview, onImportXml, onPendingChange }) {
  const [capabilities, setCapabilities] = useState(null), [error, setError] = useState("");
  const [interfaceId, setInterfaceId] = useState(""), [cidr, setCidr] = useState("");
  const [job, setJob] = useState(null), [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const tokenRef = useRef(""), jobRef = useRef(null), mountedRef = useRef(true), dialogRef = useRef(null);
  const running = job && ["queued", "running"].includes(job.status);
  const network = capabilities?.networks?.find(item => item.id === interfaceId);
  const parsed = ipv4Network(cidr), count = parsed ? 2 ** (32 - parsed.prefix) : null;
  const api = async (path, options = {}) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
    const response = await fetch(`/api/discovery${path}`, { cache: "no-store", signal: controller.signal, ...options,
      headers: { ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}), ...options.headers },
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error("The local discovery API is unavailable. Restart the local launcher."); }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
    } finally { clearTimeout(timer); }
  };
  const loadSettings = async () => {
    setBusy(true); setError("");
    try {
      const settings = await api("/capabilities");
      if (!mountedRef.current) return;
      tokenRef.current = settings.token || "";
      setCapabilities(settings);
      const first = settings.networks?.[0];
      setInterfaceId(first?.id || ""); setCidr(first?.suggestedCidr || "");
      if (settings.activeJob || settings.recentJob) {
        const existing = await api(`/jobs/${encodeURIComponent(settings.activeJob || settings.recentJob)}`);
        if (mountedRef.current) { setJob(existing); jobRef.current = existing; }
      }
    } catch (failure) { if (mountedRef.current) setError(`${failure.message} Run the app locally with dev-start.sh, or import an XML file.`); }
    finally { if (mountedRef.current) setBusy(false); }
  };
  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement;
    dialogRef.current?.querySelector("button")?.focus();
    loadSettings();
    return () => {
      mountedRef.current = false;
      const current = jobRef.current;
      if (current && ["queued", "running"].includes(current.status)) {
        fetch(`/api/discovery/jobs/${encodeURIComponent(current.id)}`, { method: "DELETE", keepalive: true, headers: { Authorization: `Bearer ${tokenRef.current}` } }).catch(() => {});
      }
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    onPendingChange(Boolean(job && ["queued", "running", "completed"].includes(job.status)));
    return () => onPendingChange(false);
  }, [job?.status, onPendingChange]);
  useEffect(() => {
    if (!running) return;
    let stopped = false, timer;
    const poll = async () => {
      try {
        const result = await api(`/jobs/${encodeURIComponent(job.id)}`);
        if (stopped) return;
        setJob(result); jobRef.current = result;
        if (["queued", "running"].includes(result.status)) timer = setTimeout(poll, 1000);
      } catch (failure) { if (!stopped) { setError(failure.message); setJob(previous => ({ ...previous, status: "failed" })); } }
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, Boolean(running)]);
  const start = async event => {
    event.preventDefault(); setBusy(true); setLaunching(true); setError("");
    try {
      const result = await api("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interfaceId, cidr }) });
      if (mountedRef.current) { setJob(result); jobRef.current = result; }
    } catch (failure) { if (mountedRef.current) setError(failure.message); }
    finally { if (mountedRef.current) { setBusy(false); setLaunching(false); } }
  };
  const cancel = async () => {
    if (!jobRef.current) return true;
    setBusy(true); setError("");
    try {
      const result = await api(`/jobs/${encodeURIComponent(jobRef.current.id)}`, { method: "DELETE" });
      if (mountedRef.current) { setJob(result); jobRef.current = result; }
      return true;
    } catch (failure) { if (mountedRef.current) setError(failure.message); return false; }
    finally { if (mountedRef.current) setBusy(false); }
  };
  const close = async () => {
    if (launching) return;
    if (running && !await cancel()) return;
    onClose();
  };
  const keyDown = event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const elements = [...dialogRef.current.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled)")];
    if (!elements.length) { event.preventDefault(); dialogRef.current.focus(); return; }
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
  };
  return <div className="inventory-backdrop"><section className="nmap-dialog discovery-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="discovery-heading" tabIndex={-1} onKeyDown={keyDown}>
    <header><div><span className="inventory-eyebrow">LOCAL NETWORK DISCOVERY</span><h2 id="discovery-heading">Discover this computer's network</h2><p>Choose a directly connected private LAN before starting.</p></div><button aria-label="Close local discovery" disabled={launching || (busy && running)} onClick={close}>×</button></header>
    <div className="nmap-body">
      {!capabilities && !error && <p>Reading local network settings…</p>}
      {capabilities && !capabilities.canStart && <div className="inventory-callout">{capabilities.reason}<p className="inventory-help">Linux local setup: install Nmap and iproute2, then restart dev-start.sh. Hosted deployments and other operating systems can use Nmap XML import.</p></div>}
      {error && <p className="inventory-error" role="alert">{error}</p>}
      {capabilities?.routingNotice && <div className="inventory-callout">{capabilities.routingNotice} These route checks do not send discovery probes.</div>}
      {capabilities?.networks?.length > 0 && <form onSubmit={start}>
        <div className="discovery-fields"><label>Network interface<select aria-label="Discovery network interface" value={interfaceId} disabled={running || busy} onChange={event => { const selected = capabilities.networks.find(item => item.id === event.target.value); setInterfaceId(event.target.value); setCidr(selected.suggestedCidr); }}>{capabilities.networks.map(item => <option key={item.id} value={item.id}>{item.interface} — {item.address} ({item.connectedCidr})</option>)}</select></label><label>Discovery range<input aria-label="Discovery CIDR range" value={cidr} disabled={running || busy} onChange={event => setCidr(event.target.value)} placeholder="192.168.1.0/24" /></label></div>
        {network && <dl className="discovery-facts"><div><dt>This computer</dt><dd>{network.address}</dd></div><div><dt>Connected network</dt><dd>{network.connectedCidr}</dd></div><div><dt>Configured gateway</dt><dd>{network.gateway || "Not reported"}</dd></div><div><dt>Selected scope</dt><dd>{count ? `${count} addresses` : "Enter an IPv4 CIDR"}</dd></div></dl>}
        <div className="inventory-callout">Starting discovery sends probes from this computer to the selected range. Choose a network you manage. Nothing runs automatically when you open this panel.</div>
        <p className="inventory-help">Host discovery only: no port scan, OS fingerprinting, or DNS lookups. Some devices may not respond. MAC addresses may be available from this computer's neighbor cache. Virtual/VPN interfaces are excluded.</p>
        <div className="inventory-toolbar"><button type="submit" className="inventory-primary" disabled={!capabilities.canStart || busy || running || !count || count > 256 || !cidr.includes("/")}>Start discovery</button><button type="button" disabled={busy || running} onClick={loadSettings}>Refresh network settings</button></div>
      </form>}
      {job && <section className="discovery-progress" aria-live="polite"><strong>{({ queued: job.phase === "verifying-routes" ? "Checking selected network routes…" : "Preparing discovery", running: "Discovering responding hosts…", completed: "Discovery complete — ready for review", cancelled: "Discovery cancelled", failed: "Discovery could not finish" })[job.status]}</strong><p>{job.network.interface} · {job.network.cidr} · {job.elapsedSeconds}s elapsed · {job.timeoutSeconds}s maximum</p>{job.startedAt && <p>Started {new Date(job.startedAt).toLocaleString()}. Results remain available for 15 minutes or until the app restarts.</p>}{job.error && <p>{job.error}</p>}{running && <button disabled={busy} onClick={cancel}>Cancel discovery</button>}{job.status === "completed" && <button className="inventory-primary" onClick={() => onReview(job)}>Review discovered hosts</button>}</section>}
    </div>
    <footer><span>Results enter the existing inventory review. No cables or real configuration changes are made.</span><button onClick={onImportXml} disabled={running || busy}>Import XML instead</button><button onClick={close} disabled={launching || (busy && running)}>{running ? "Cancel and close" : "Close"}</button></footer>
  </section></div>;
}
