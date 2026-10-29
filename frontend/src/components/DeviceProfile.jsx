import React, { useEffect, useRef, useState } from "react";
import { DEVICE_TYPES, NON_IP_TYPES, profileDraft, deviceCommandName } from "../deviceProfile.mjs";
import "./deviceProfile.css";

export default function DeviceProfile({ device, onSave, onClose, onPendingChange, context = "lab" }) {
  const [draft, setDraft] = useState(() => profileDraft(device));
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const initialRef = useRef(JSON.stringify(profileDraft(device)));
  const dirty = JSON.stringify(draft) !== initialRef.current;
  const observations = [...(device.discovery?.observations || [])].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const latest = observations[0];
  const ipCapable = !NON_IP_TYPES.has(draft.type);
  const inventory = context === "inventory";
  const managedFirewall = device.type === "firewall" && draft.type === "firewall" && device.interfaces?.some(item => item.enabled);
  useEffect(() => {
    onPendingChange(dirty);
    return () => onPendingChange(false);
  }, [dirty, onPendingChange]);
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector("input")?.focus();
    return () => previousFocus?.isConnected && previousFocus.focus();
  }, []);
  const update = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setError(""); };
  const save = (event) => {
    event.preventDefault();
    if (device.type === "firewall" && draft.type !== "firewall" && (device.interfaces?.length || device.rules?.length || device.nat?.length)
        && !window.confirm("Changing this firewall to another type removes its interface, rule, and NAT configuration. Continue?")) return;
    const result = onSave(draft);
    if (result.errors?.length) setError(result.errors.join(" "));
  };
  const trapFocus = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const elements = [...dialogRef.current.querySelectorAll("button:not(:disabled),input:not(:disabled),select,textarea")];
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
  };
  return <div className="profile-backdrop">
    <section className="device-profile" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="device-profile-heading" onKeyDown={trapFocus}>
      <header><div><span className="profile-eyebrow">{inventory ? "DISCOVERED INVENTORY" : "LAB DEVICE"}</span><h2 id="device-profile-heading">Edit device profile</h2><p>Give this device a name you recognize.</p></div><button type="button" aria-label="Close device profile" onClick={onClose}>×</button></header>
      <form onSubmit={save}>
        <div className="profile-scroll">
          <div className="profile-fields">
            <label>Display name<input aria-label="Display name" value={draft.name} onChange={event => update("name", event.target.value)} maxLength={200} required /></label>
            <label>Device type<select aria-label="Device type" value={draft.type} onChange={event => update("type", event.target.value)}>{Object.entries(DEVICE_TYPES).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
            <label>{inventory ? "Lab IPv4 override (optional)" : "Configured IPv4 address"}<input aria-label="Configured IPv4 address" value={ipCapable ? draft.ip : ""} disabled={!ipCapable || Boolean(managedFirewall)} onChange={event => update("ip", event.target.value)} placeholder={inventory ? "Use observed IP in practice copy" : "10.10.10.10/24"} /></label>
          </div>
          <p className="profile-help">{inventory ? "This optional override is for practice copies. It does not change the observed IP or configure the physical device." : managedFirewall ? "Manage this firewall's interface addresses in its dashboard." : ipCapable ? "This address belongs to your simulated lab. Editing it does not change a physical device." : "This peripheral has no IP stack. Its configured IP and routes will be cleared."}</p>
          <label className="profile-notes">Notes<textarea aria-label="Device notes" value={draft.notes} onChange={event => update("notes", event.target.value)} maxLength={4000} rows={3} placeholder="Location, purpose, owner, or anything that helps you recognize it." /><small>{draft.notes.length}/4,000 characters</small></label>
          <div className="profile-command"><span>{inventory ? "Practice, then explore" : "Simulated terminal"}</span>{inventory ? <small>Make a practice copy from Inventory to use simulated commands. No real SSH connection is opened here.</small> : ipCapable ? <><code>ssh {deviceCommandName(draft.name.trim() || device.name)}</code><small>Names containing spaces need quotes. Set an IP before opening a simulated session.</small></> : <small>This device type has no IP stack and cannot open an SSH session.</small>}</div>
          <section className="profile-observed" aria-labelledby="observed-heading"><div className="profile-section-heading"><h3 id="observed-heading">Discovery observations</h3><span>Read only</span></div>
            <p>Your chosen name, type, and configured IP stay separate from discovered information.</p>
            {!latest ? <div className="profile-empty">No discovery observations yet. Import a scan in Inventory and make a practice copy to explore discovered devices.</div> : <>
              <dl><div><dt>Discovered hostname</dt><dd>{latest.hostname || "Not reported"}</dd></div><div><dt>Observed IP</dt><dd>{latest.ip || "Not reported"}</dd></div><div><dt>Observed MAC</dt><dd>{latest.mac || "Not reported"}</dd></div><div><dt>Suggested type</dt><dd>{DEVICE_TYPES[latest.suggestedType] || latest.suggestedType || "Unknown"}{latest.confidence !== undefined && ` (${Math.round(latest.confidence * 100)}% confidence)`}</dd></div><div><dt>Discovery source</dt><dd>{latest.source}</dd></div><div><dt>First seen</dt><dd>{new Date(device.discovery.firstSeen || observations.at(-1).observedAt).toLocaleString()}</dd></div><div><dt>Last seen</dt><dd>{new Date(device.discovery.lastSeen || latest.observedAt).toLocaleString()}</dd></div></dl>
              {latest.evidence?.length > 0 && <ul>{latest.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
              {latest.vendor && <p>Reported vendor: {latest.vendor}</p>}
              {latest.services?.length > 0 && <details className="profile-services"><summary>{latest.services.length} reported port records</summary><div className="inventory-table-scroll"><table><thead><tr><th>Port</th><th>State</th><th>Service / product</th><th>Evidence</th></tr></thead><tbody>{latest.services.map((service, index) => <tr key={index}><td>{service.port}/{service.protocol}</td><td>{service.state}</td><td>{service.name || "Not reported"}<small>{[service.product, service.version].filter(Boolean).join(" ")}</small></td><td>{service.method === "probed" ? "Service probe" : service.method === "table" ? "Port-name lookup" : "Not reported"}</td></tr>)}</tbody></table></div></details>}
              {observations.length > 1 && <details><summary>{observations.length} recorded observations</summary>{observations.map((item, index) => <p key={index}>{new Date(item.observedAt).toLocaleString()} · {item.source} · {item.ip || "IP not reported"} · {item.hostname || "Hostname not reported"}</p>)}</details>}
            </>}
          </section>
          {error && <p className="profile-error" role="alert">{error}</p>}
        </div>
        <footer><span>{dirty ? "Unapplied profile changes" : "Export your lab to keep this profile."}</span><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="profile-save">Save profile</button></footer>
      </form>
    </section>
  </div>;
}
