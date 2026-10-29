import React, { useEffect, useRef, useState } from "react";
import { MAX_NMAP_BYTES, parseNmapXml, suggestInventoryMatch, withLocalDiscoveryContext } from "../nmapImport.mjs";
import { DEVICE_TYPES } from "../deviceProfile.mjs";
import sampleScan from "../examples/nmap-sample.xml?raw";
import "./inventory.css";

export default function NmapImport({ inventory, onApply, onClose, localResult }) {
  const [scan, setScan] = useState(null), [rows, setRows] = useState([]), [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const dialogRef = useRef(null), requestRef = useRef(0);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector("button")?.focus();
    return () => { requestRef.current++; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (localResult) read(new File([localResult.xml], "local-discovery.xml", { type: "application/xml" }), false, localResult);
  }, []);
  const read = async (file, isSample = false, discoveryResult = null) => {
    if (!file) return;
    const request = ++requestRef.current;
    setReading(true); setError(""); setScan(null); setRows([]);
    try {
      if (file.size > MAX_NMAP_BYTES) throw new Error("Nmap XML files must be 5 MB or smaller.");
      let parsed = parseNmapXml(await file.text(), { sourceFile: file.name });
      if (discoveryResult) parsed = withLocalDiscoveryContext(parsed, discoveryResult);
      if (request !== requestRef.current) return;
      if (isSample) parsed.candidates.forEach(candidate => {
        candidate.observation.source = "Sample Nmap XML";
        candidate.observation.evidence.unshift("Example data provided by Network Lab; no network was scanned.");
      });
      setScan({ ...parsed, isSample });
      setRows(parsed.candidates.map(candidate => ({ key: candidate.key, ...suggestInventoryMatch(candidate, inventory) })));
    } catch (failure) { if (request === requestRef.current) setError(`${failure.message} The lab and inventory have not changed.`); }
    finally { if (request === requestRef.current) setReading(false); }
  };
  const patch = (key, fields) => setRows(previous => previous.map(row => row.key === key ? { ...row, ...fields } : row));
  const selected = rows.filter(row => row.selected).length;
  const apply = () => {
    const result = onApply(scan.candidates, rows);
    if (result?.error) setError(result.error);
  };
  const keyDown = event => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialogRef.current.querySelectorAll("button:not(:disabled),input:not(:disabled),select")];
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
  };
  return <div className="inventory-backdrop"><section className="nmap-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="nmap-heading" onKeyDown={keyDown}>
    <header><div><span className="inventory-eyebrow">DISCOVERY IMPORT</span><h2 id="nmap-heading">{localResult ? "Review local discovery" : "Import an Nmap scan"}</h2><p>Review observed devices before adding them to your inventory.</p></div><button aria-label="Close Nmap import" onClick={onClose}>×</button></header>
    <div className="nmap-body">
      <div className="inventory-callout">{localResult ? `Results from ${localResult.network.interface} on ${localResult.network.cidr}. Reviewing does not create cables or change real devices.` : "Choose an existing Nmap XML file. Parsing happens in your browser. This does not run a scan or create physical connections."}</div>
      <div className="inventory-toolbar"><label className="inventory-file">Choose XML file<input type="file" accept=".xml,application/xml,text/xml" aria-label="Nmap XML file" disabled={reading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; read(file); }} /></label><button disabled={reading} onClick={() => read(new File([sampleScan], "sample-network.xml", { type: "application/xml" }), true)}>Try a sample file</button><span>{reading ? "Reading scan…" : "Up to 5 MB · IPv4 hosts"}</span></div>
      {error && <p className="inventory-error" role="alert">{error}</p>}
      {scan && <>
        <div className="inventory-summary"><strong>{scan.candidates.length} reviewable hosts</strong><span>{scan.sourceFile}{scan.isSample ? " — example data" : ""}</span><span>{scan.skipped.notUp} not up · {scan.skipped.unsupported} without supported IPv4 · {scan.skipped.duplicate} repeated addresses skipped</span></div>
        <p className="inventory-help">New assets start as Unknown. A suggested type is evidence you can review in the profile. Matching an existing asset adds observations without changing your names, types, notes, or configured addresses.</p>
        <div className="inventory-table-scroll"><table><thead><tr><th>Include</th><th>Observed host</th><th>MAC / vendor</th><th>Suggested type</th><th>Import destination</th></tr></thead><tbody>{scan.candidates.map((candidate, index) => {
          const row = rows[index], observed = candidate.observation;
          return <tr key={candidate.key}><td><input type="checkbox" aria-label={`Include ${observed.ip}`} checked={row.selected} onChange={event => patch(row.key, { selected: event.target.checked })} /></td><td><strong>{observed.ip}</strong><small>{observed.hostname || "Hostname not reported"}</small><small>{observed.services.filter(service => service.state === "open").length} individually reported open ports</small></td><td>{observed.mac || "Not reported"}<small>{observed.vendor || "Vendor not reported"}</small></td><td>{DEVICE_TYPES[observed.suggestedType] || "Unknown"}{observed.confidence !== undefined && <small>{Math.round(observed.confidence * 100)}% reported confidence</small>}</td><td><select aria-label={`Import destination for ${observed.ip}`} value={row.targetId} onChange={event => patch(row.key, { targetId: event.target.value })}><option value="new">Create a new inventory asset</option>{inventory.map(asset => <option key={asset.id} value={asset.id}>Update observations: {asset.name}</option>)}</select><small className={!row.selected ? "inventory-review" : ""}>{row.reason}</small></td></tr>;
        })}</tbody></table></div>
        {!scan.candidates.length && <p>No supported hosts reported as up were found. Nothing will be imported.</p>}
        {scan.warnings.length > 0 && <details><summary>{scan.warnings.length} import notes</summary><ul>{scan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </>}
    </div>
    <footer><span>{selected} selected · Review IP-only matches before including them.</span><button onClick={onClose}>Cancel</button><button className="inventory-primary" disabled={!selected || reading} onClick={apply}>Import selected hosts</button></footer>
  </section></div>;
}
