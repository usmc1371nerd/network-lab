import React, { useState } from "react";
import { latestObservation } from "../nmapImport.mjs";
import { DEVICE_TYPES } from "../deviceProfile.mjs";
import "./inventory.css";

export default function InventoryWorkspace({ assets, onImport, onEdit, onCopy, onBack, onDiscover }) {
  const [selected, setSelected] = useState(new Set()), [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const filtered = assets.filter(asset => [asset.name, latestObservation(asset)?.ip, latestObservation(asset)?.hostname].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  const chosen = assets.filter(asset => selected.has(asset.id));
  const toggle = id => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <section className="inventory-workspace" aria-label="Discovered device inventory">
    <div className="inventory-page-heading"><div><span className="inventory-eyebrow">MY NETWORK / INVENTORY</span><h2>Discover, review, understand</h2><p>Observed devices stay separate from your simulated lab.</p></div><div className="inventory-actions"><button onClick={onBack}>Back to lab</button><button onClick={onDiscover}>Discover local network</button><button className="inventory-primary" onClick={onImport}>Import Nmap XML</button></div></div>
    <div className="inventory-callout">This is a saved view of scan evidence, not a live network map. No cables, subnets, or current online status are inferred. Use a practice copy to experiment without changing real devices.</div>
    <div className="inventory-toolbar"><label>Find a device<input aria-label="Find inventory device" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, observed IP, or hostname" /></label><span>{assets.length} assets · {chosen.length} selected</span><button disabled={!chosen.length} onClick={() => { const result = onCopy(chosen); if (result?.error) setMessage(result.error); }}>Add selected to practice lab</button></div>
    {message && <p className="inventory-error" role="alert">{message}</p>}
    {!assets.length ? <div className="inventory-empty"><span>◎</span><h3>Start with a scan you already have</h3><p>Import Nmap XML to review hosts, reported services, and device-type suggestions. You can try the sample scan first.</p><button onClick={onImport}>Import or try sample</button></div> : <div className="inventory-table-scroll"><table><thead><tr><th>Select</th><th>Your device name</th><th>Observed IPv4</th><th>Your type</th><th>Last seen in scan</th><th>Reported services</th><th /></tr></thead><tbody>{filtered.map(asset => { const observation = latestObservation(asset); return <tr key={asset.id}>
      <td><input type="checkbox" aria-label={`Select ${asset.name}`} checked={selected.has(asset.id)} onChange={() => toggle(asset.id)} /></td><td><strong>{asset.name}</strong><small>{observation?.hostname || "Hostname not reported"}</small></td><td>{observation?.ip || "Not reported"}<small>{observation?.mac || "MAC not reported"}</small></td><td>{DEVICE_TYPES[asset.type] || asset.type}<small>{asset.type === "unknown" ? "Review the suggestion in its profile" : "Your classification"}</small></td><td>{observation ? new Date(observation.observedAt).toLocaleString() : "Not reported"}<small>{observation?.sourceFile || observation?.source}</small></td><td>{observation?.services?.filter(service => service.state === "open").slice(0, 4).map(service => <span className="inventory-port" key={`${service.protocol}-${service.port}`}>{service.port}/{service.protocol} {service.name || "unknown"}</span>)}{!observation?.services?.some(service => service.state === "open") && <small>No individual open ports reported</small>}</td><td><button aria-label={`Edit inventory profile for ${asset.name}`} onClick={() => onEdit(asset.id)}>Edit profile</button></td>
    </tr>; })}</tbody></table>{!filtered.length && <p className="inventory-help">No devices match your search.</p>}</div>}
    <p className="inventory-help">Export lab includes this inventory. Applying another scan keeps user corrections and devices not present in that scan. Practice copies have independent IDs and no automatically created cables or routes. They use the simulator's /24 prefix unless you set a lab IPv4 override; this is not a discovered subnet mask.</p>
  </section>;
}
