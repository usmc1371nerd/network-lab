import React, { useEffect, useRef, useState } from "react";
import { validateFirewall } from "../firewallConfig.mjs";
import "./firewall.css";

const pages = ["Overview", "Interfaces", "Firewall rules", "Live log", "Routing", "Diagnostics"];
const newId = () => crypto.randomUUID();
const makeDraft = (device) => ({
  firewallEnabled: Boolean(device.firewallEnabled),
  interfaces: device.interfaces || [], rules: device.rules || [],
});

export default function FirewallDashboard({ device, devices, connections, logs, onUpdateDevice, onBack, onClearLogs, onDiagnosticResult, onPendingChange }) {
  const [page, setPage] = useState("Overview");
  const [draft, setDraft] = useState(() => makeDraft(device));
  const [message, setMessage] = useState("");
  const [selectedInterface, setSelectedInterface] = useState("all");
  const [target, setTarget] = useState("");
  const [diagnosticAddress, setDiagnosticAddress] = useState("");
  const [output, setOutput] = useState([]);
  const [running, setRunning] = useState(false);
  const requestRef = useRef(null);
  const saved = JSON.stringify(makeDraft(device));
  const dirty = JSON.stringify(draft) !== saved;
  useEffect(() => { setDraft(makeDraft(device)); }, [device.id, saved]);
  useEffect(() => {
    onPendingChange?.(dirty);
    return () => onPendingChange?.(false);
  }, [dirty, onPendingChange]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (selectedInterface !== "all" && !draft.interfaces.some(item => item.id === selectedInterface)) setSelectedInterface("all");
  }, [draft.interfaces, selectedInterface]);
  const neighbors = connections.filter(c => c.from === device.id || c.to === device.id)
    .map(c => devices.find(d => d.id === (c.from === device.id ? c.to : c.from))).filter(Boolean);
  const patchInterface = (id, fields) => setDraft(d => ({ ...d, interfaces: d.interfaces.map(i => i.id === id ? { ...i, ...fields } : i) }));
  const patchRule = (id, fields) => setDraft(d => ({ ...d, rules: d.rules.map(r => r.id === id ? { ...r, ...fields } : r) }));
  const moveRule = (id, delta) => setDraft(d => {
    const rules = [...d.rules], index = rules.findIndex(r => r.id === id), next = index + delta;
    if (next >= 0 && next < rules.length) [rules[index], rules[next]] = [rules[next], rules[index]];
    return { ...d, rules };
  });
  const apply = () => {
    const errors = validateFirewall(draft, neighbors.map(n => n.id));
    if (errors.length) { setMessage(errors.join(" ")); return; }
    const primary = draft.interfaces.find(i => i.enabled && i.name.toUpperCase() === "LAN") || draft.interfaces.find(i => i.enabled);
    onUpdateDevice(device.id, { ...draft, firewallVersion: 1, ...(primary ? { ip: primary.address } : {}) });
    setMessage("Configuration applied. New ping commands use these settings. Export your lab to keep them.");
  };
  const runDiagnostic = async (event) => {
    event.preventDefault();
    if (!target.trim() || /\s/.test(target.trim())) { setOutput(["Enter a device name or IP address."]); return; }
    if (dirty) { setOutput(["Apply or discard pending settings before running diagnostics."]); return; }
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setRunning(true);
    try {
      const response = await fetch("/api/run-command", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ command: `ping ${target.trim()}`, devices, connections, sourceDeviceId: device.id, sourceAddress: diagnosticAddress || device.ip }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (controller.signal.aborted) return;
      setOutput(result.output || []);
      onDiagnosticResult(result);
    } catch (error) { if (error.name !== "AbortError") setOutput([error.message]); }
    finally { if (!controller.signal.aborted) setRunning(false); }
  };
  const filteredRules = draft.rules.filter(rule => selectedInterface === "all" || rule.interfaceId === selectedInterface);
  const heading = { Overview: "Lobby / Dashboard", Interfaces: "Interfaces / Assignments", "Firewall rules": "Firewall / Rules", "Live log": "Firewall / Log Files / Live View", Routing: "System / Routes", Diagnostics: "Interfaces / Diagnostics / Ping" }[page];
  return (
    <section className="fw-workspace" aria-label={`${device.name} firewall dashboard`}>
      <aside className="fw-sidebar">
        <div className="fw-brand"><span>◈</span> NETWORK LAB <small>Firewall simulator</small></div>
        <div className="fw-host">{device.name}<small>{device.ip || "No management address"}</small></div>
        <nav aria-label="Firewall navigation">{pages.map(item => <button key={item} className={page === item ? "active" : ""} onClick={() => setPage(item)}>{item}</button>)}</nav>
        <button className="fw-back" onClick={() => { if (!dirty || window.confirm("Discard unapplied firewall settings and return to topology?")) onBack(); }}>← Back to topology</button>
      </aside>
      <div className="fw-content">
        <div className="fw-topbar"><span>{heading}</span><span className={`fw-badge ${device.firewallEnabled ? "pass" : "block"}`}>{device.firewallEnabled ? "FILTERING ACTIVE" : "ROUTING ONLY"}</span></div>
        <div className="fw-page">
          <div className="fw-page-heading"><div><h2>{page}</h2><p>OPNsense-inspired learning workspace · IPv4 and ICMP simulation</p></div>
            <div className="fw-actions"><span>{dirty ? "Unapplied changes" : "Configuration applied"}</span><button onClick={() => { setDraft(makeDraft(device)); setMessage(""); }} disabled={!dirty}>Discard</button><button className="primary" onClick={apply}>Apply changes</button></div>
          </div>
          {message && <div className="fw-notice" role="status">{message}</div>}
          {page === "Overview" && <>
            <div className="fw-cards">
              <article><span>Interfaces enabled</span><strong>{device.interfaces?.filter(i => i.enabled).length || 0}</strong><small>{neighbors.length} physical connections</small></article>
              <article><span>Rules enabled</span><strong>{device.rules?.filter(r => r.enabled).length || 0}</strong><small>First matching ingress rule wins</small></article>
              <article><span>Logged decisions</span><strong>{logs.length}</strong><small>{logs.filter(l => l.action === "block").length} blocked · {logs.filter(l => l.action === "pass").length} passed</small></article>
            </div>
            <div className="fw-panel"><h3>Build a routed network</h3><ol><li>Connect each firewall port to a switch, host, or server.</li><li>Assign LAN, WAN, or OPT interfaces to those cables, with a different subnet on each interface.</li><li>On each endpoint, add a route through the firewall address on its own subnet. Replies need a route back.</li><li>Add an ingress Pass rule for the traffic you want to allow, then enable filtering and apply.</li><li>Run a ping from the terminal and inspect Live log to follow the decision.</li></ol></div>
            <div className="fw-panel"><h3>Simulation scope</h3><p>Filtering is opt-in. When enabled, unmatched ICMP is blocked. Allowed requests create state for their replies during that ping command. ARP is not filtered.</p><p>This is a teaching model, not OPNsense. TCP/UDP filtering, persistent states, NAT, DHCP, VLANs, and VPNs are not implemented. Terminal sendpkt and traceroute are outside the ICMP rule engine.</p></div>
          </>}
          {page === "Interfaces" && <div className="fw-panel"><h3>Interface assignments</h3><p>One interface per physical cable. Use CIDR notation (for example 10.10.10.1/24). Connect a switch to share a LAN between several PCs.</p>
            <div className="fw-table-scroll"><table><thead><tr><th>Enabled</th><th>Name</th><th>Connected device / port</th><th>IPv4 address</th><th /></tr></thead><tbody>{draft.interfaces.map(item => <tr key={item.id}>
              <td><input aria-label={`Enable ${item.name}`} type="checkbox" checked={item.enabled} onChange={e => patchInterface(item.id, { enabled: e.target.checked })} /></td>
              <td><input aria-label="Interface name" value={item.name} maxLength={32} onChange={e => patchInterface(item.id, { name: e.target.value })} /></td>
              <td><select aria-label={`Connected device for ${item.name}`} value={item.neighborId} onChange={e => patchInterface(item.id, { neighborId: e.target.value })}><option value="">Choose a cable</option>{neighbors.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}{item.neighborId && !neighbors.some(n => n.id === item.neighborId) && <option value={item.neighborId}>Disconnected port</option>}</select></td>
              <td><input aria-label={`IPv4 address for ${item.name}`} value={item.address} placeholder="10.10.10.1/24" onChange={e => patchInterface(item.id, { address: e.target.value })} /></td>
              <td><button onClick={() => setDraft(d => ({ ...d, interfaces: d.interfaces.filter(i => i.id !== item.id), rules: d.rules.filter(r => r.interfaceId !== item.id) }))}>Remove</button></td>
            </tr>)}</tbody></table></div>
            {!draft.interfaces.length && <p>No interfaces assigned. Add LAN and WAN to begin.</p>}
            <button onClick={() => setDraft(d => ({ ...d, interfaces: [...d.interfaces, { id: newId(), name: d.interfaces.length === 0 ? "LAN" : d.interfaces.length === 1 ? "WAN" : `OPT${d.interfaces.length - 1}`, neighborId: "", address: "", enabled: true }] }))}>+ Add interface</button>
          </div>}
          {page === "Firewall rules" && <>
            <div className="fw-panel"><label className="fw-check"><input type="checkbox" checked={draft.firewallEnabled} onChange={e => setDraft(d => ({ ...d, firewallEnabled: e.target.checked }))} />Enable firewall filtering</label><p>Rules apply to traffic entering an interface, top to bottom. No match means Block. Replies to an allowed ping use state, so they do not need a second Pass rule.</p></div>
            <div className="fw-tabs"><button className={selectedInterface === "all" ? "active" : ""} onClick={() => setSelectedInterface("all")}>All interfaces</button>{draft.interfaces.map(i => <button key={i.id} className={selectedInterface === i.id ? "active" : ""} onClick={() => setSelectedInterface(i.id)}>{i.name}</button>)}</div>
            <div className="fw-panel"><div className="fw-table-scroll"><table className="fw-rules"><thead><tr><th>On</th><th>Action</th><th>Interface</th><th>Protocol</th><th>Source</th><th>Destination</th><th>Description</th><th>Order</th></tr></thead><tbody>{filteredRules.map(rule => <tr key={rule.id}>
              <td><input type="checkbox" aria-label="Enable rule" checked={rule.enabled} onChange={e => patchRule(rule.id, { enabled: e.target.checked })} /></td>
              <td><select aria-label="Rule action" value={rule.action} onChange={e => patchRule(rule.id, { action: e.target.value })}><option value="pass">Pass</option><option value="block">Block</option></select></td>
              <td><select aria-label="Rule interface" value={rule.interfaceId} onChange={e => patchRule(rule.id, { interfaceId: e.target.value })}><option value="">Choose</option>{draft.interfaces.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></td>
              <td><select aria-label="Rule protocol" value={rule.protocol} onChange={e => patchRule(rule.id, { protocol: e.target.value })}><option value="ICMP">ICMP</option><option value="any">Any*</option></select></td>
              <td><input aria-label="Rule source" value={rule.source} onChange={e => patchRule(rule.id, { source: e.target.value.trim() })} /></td>
              <td><input aria-label="Rule destination" value={rule.destination} onChange={e => patchRule(rule.id, { destination: e.target.value.trim() })} /></td>
              <td><input aria-label="Rule description" value={rule.description} maxLength={200} onChange={e => patchRule(rule.id, { description: e.target.value })} /></td>
              <td className="fw-order"><button aria-label="Move rule up" disabled={draft.rules[0]?.id === rule.id} onClick={() => moveRule(rule.id, -1)}>↑</button><button aria-label="Move rule down" disabled={draft.rules.at(-1)?.id === rule.id} onClick={() => moveRule(rule.id, 1)}>↓</button><button aria-label="Remove rule" onClick={() => setDraft(d => ({ ...d, rules: d.rules.filter(r => r.id !== rule.id) }))}>×</button></td>
            </tr>)}</tbody></table></div>
            {!filteredRules.length && <p>No rules on this interface. With filtering enabled, new incoming pings are blocked.</p>}
            <button disabled={!draft.interfaces.length} onClick={() => setDraft(d => ({ ...d, rules: [...d.rules, { id: newId(), enabled: true, action: "pass", interfaceId: selectedInterface === "all" ? d.interfaces[0]?.id || "" : selectedInterface, protocol: "ICMP", source: "interface-net", destination: "any", description: "" }] }))}>+ Add rule</button>
            <p className="fw-help">Addresses: any, interface-net (the ingress subnet), an IP, or CIDR. *Any currently covers simulated ICMP only.</p></div>
          </>}
          {page === "Live log" && <div className="fw-panel"><div className="fw-section-heading"><h3>Live firewall decisions</h3><button onClick={onClearLogs}>Clear log</button></div><p>Records incoming ping decisions and state-matched replies. Logs reset on import or refresh; the latest 500 events are kept.</p><div className="fw-table-scroll"><table><thead><tr><th>Time</th><th>Action</th><th>Interface</th><th>Source</th><th>Destination</th><th>Seq</th><th>Reason</th></tr></thead><tbody>{[...logs].reverse().map((event, index) => <tr key={index}><td>{new Date(event.recordedAt).toLocaleTimeString()}</td><td><span className={`fw-badge ${event.action}`}>{event.action.toUpperCase()}</span></td><td>{event.interface}</td><td>{event.src}</td><td>{event.dst}</td><td>{event.sequence}</td><td>{event.reason}</td></tr>)}</tbody></table></div>{!logs.length && <p>No firewall decisions yet. Run a ping that enters this firewall.</p>}</div>}
          {page === "Routing" && <div className="fw-panel"><h3>Connected and static routes</h3><p>Enabled interfaces create connected routes. Manage endpoint routes in the terminal with <code>ip route add &lt;subnet&gt; via &lt;firewall-interface-IP&gt;</code>.</p><table><thead><tr><th>Network / interface</th><th>Next hop</th><th>Type</th></tr></thead><tbody>{device.interfaces?.filter(i => i.enabled).map(i => <tr key={i.id}><td>{i.address} ({i.name})</td><td>Direct</td><td>Connected</td></tr>)}{device.routes?.map((r, i) => <tr key={i}><td>{r.network}</td><td>{r.via}</td><td>Static</td></tr>)}</tbody></table><p>To add firewall static routes, SSH into {device.name} from the terminal and use the same route command.</p></div>}
          {page === "Diagnostics" && <div className="fw-panel"><h3>Ping from this firewall</h3><p>Choose the outgoing source address. To test ingress rules, run a ping from an endpoint in the terminal.</p><form className="fw-diagnostics" onSubmit={runDiagnostic}><label>Source address<select value={diagnosticAddress} onChange={e => setDiagnosticAddress(e.target.value)}><option value="">Management ({device.ip || "unset"})</option>{device.interfaces?.filter(i => i.enabled).map(i => <option key={i.id} value={i.address}>{i.name} — {i.address}</option>)}</select></label><label>Target<input value={target} onChange={e => setTarget(e.target.value)} placeholder="server-4 or 10.10.30.10" /></label><button className="primary" disabled={running || dirty}>{running ? "Running…" : "Run ping"}</button></form><pre className="fw-output">{output.join("\n") || "Results will appear here."}</pre></div>}
        </div>
      </div>
    </section>
  );
}
