
import React, { useState, useRef } from "react";

const DEVICE_ICONS = {
  pc: "💻",
  server: "🖥️",
  router: "📡",
  switch: "🔀",
  phone: "📱",
  laptop: "💼",
  beacon: "📶",
  sensor: "🌡️",
  gateway: "🛰️",
  "iot-bulb": "💡",
  "iot-lock": "🔒",
  "iot-tag": "🏷️",
  "iot-camera": "📷",
  "iot-thermostat": "🌡️",
  "iot-plug": "🔌",
  "usb-storage": "💾",
  "usb-keyboard": "⌨️",
  "usb-mouse": "🖱️",
  "usb-webcam": "📹",
  "usb-audio": "🎧",
  "usb-printer": "🖨️",
};
const DEVICE_LABELS = {
  pc: "PC",
  server: "Server",
  router: "Router",
  switch: "Switch",
  phone: "Phone",
  laptop: "Laptop",
  beacon: "BLE Beacon",
  sensor: "BLE Sensor",
  gateway: "BT Gateway",
  "iot-bulb": "IoT Bulb",
  "iot-lock": "IoT Lock",
  "iot-tag": "IoT Tag",
  "iot-camera": "IoT Camera",
  "iot-thermostat": "IoT Thermostat",
  "iot-plug": "IoT Plug",
  "usb-storage": "Removable Storage",
  "usb-keyboard": "USB Keyboard",
  "usb-mouse": "USB Mouse",
  "usb-webcam": "USB Webcam",
  "usb-audio": "USB Audio",
  "usb-printer": "USB Printer",
};
const PALETTE_GROUPS = [
  {
    title: "Core",
    devices: ["pc", "server", "router", "switch"],
  },
  {
    title: "Bluetooth",
    devices: ["phone", "laptop", "beacon", "sensor", "gateway"],
  },
  {
    title: "IoT",
    devices: ["iot-bulb", "iot-lock", "iot-tag", "iot-camera", "iot-thermostat", "iot-plug"],
  },
  {
    title: "Other Devices",
    devices: ["usb-storage", "usb-keyboard", "usb-mouse", "usb-webcam", "usb-audio", "usb-printer"],
  },
];
const NODE_W = 136;
const NODE_H = 68;

export default function NetworkCanvas({
  devices,
  connections,
  trafficStats,
  linkTrafficStats,
  onAddDevice,
  onUpdateDevice,
  onRemoveDevice,
  onAddConnection,
  onUpdateConnection,
}) {
  const canvasRef = useRef(null);
  const draggingRef = useRef(null);

  const [connectMode, setConnectMode] = useState(false);
  const [connectSource, setConnectSource] = useState(null);
  const [connectDirection, setConnectDirection] = useState("both");
  const [editingId, setEditingId] = useState(null);
  const [editIpValue, setEditIpValue] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [selectedConnectionKey, setSelectedConnectionKey] = useState(null);
  const [advancedLinkControls, setAdvancedLinkControls] = useState(false);
  const [linkPreset, setLinkPreset] = useState("stable");

  /* ── palette drag ─────────────────────────────────────────── */
  const onPaletteDragStart = (e, type) => {
    e.dataTransfer.setData("deviceType", type);
  };

  /* ── canvas drop ──────────────────────────────────────────── */
  const onCanvasDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("deviceType");
    if (!type) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left - NODE_W / 2);
    const y = Math.max(0, e.clientY - rect.top - NODE_H / 2);
    onAddDevice(type, x, y);
  };

  /* ── device drag within canvas ────────────────────────────── */
  const onDeviceMouseDown = (e, device) => {
    if (connectMode) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
    e.stopPropagation();
    const rect = canvasRef.current.getBoundingClientRect();
    draggingRef.current = {
      id: device.id,
      offsetX: e.clientX - rect.left - device.x,
      offsetY: e.clientY - rect.top - device.y,
    };
  };

  const onCanvasMouseMove = (e) => {
    if (!draggingRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(rect.width - NODE_W, e.clientX - rect.left - draggingRef.current.offsetX)
    );
    const y = Math.max(
      0,
      Math.min(rect.height - NODE_H, e.clientY - rect.top - draggingRef.current.offsetY)
    );
    onUpdateDevice(draggingRef.current.id, { x, y });
  };

  const onCanvasMouseUp = () => {
    draggingRef.current = null;
  };

  /* ── device click ─────────────────────────────────────────── */
  const onDeviceClick = (e, device) => {
    e.stopPropagation();
    if (connectMode) {
      if (!connectSource) {
        setConnectSource(device.id);
      } else if (connectSource !== device.id) {
        onAddConnection(connectSource, device.id, connectDirection);
        setConnectSource(null);
        setConnectMode(false);
      }
      return;
    }
    setEditingId(device.id);
    setEditIpValue(device.ip || "");
  };

  const commitIp = (id) => {
    onUpdateDevice(id, { ip: editIpValue.trim() });
    setEditingId(null);
  };

  const cancelConnect = () => {
    setConnectMode(false);
    setConnectSource(null);
  };

  const center = (d) => ({ cx: d.x + NODE_W / 2, cy: d.y + NODE_H / 2 });

  const toggleGroup = (title) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [title]: !prev[title],
    }));
  };

  const collapseAllGroups = () => {
    const allCollapsed = {};
    PALETTE_GROUPS.forEach((group) => {
      allCollapsed[group.title] = true;
    });
    setCollapsedGroups(allCollapsed);
  };

  const expandAllGroups = () => {
    setCollapsedGroups({});
  };

  const selectedConnection =
    connections.find((conn) => `${conn.from}->${conn.to}` === selectedConnectionKey) || null;

  const selectedSource = selectedConnection
    ? devices.find((device) => device.id === selectedConnection.from)
    : null;
  const selectedTarget = selectedConnection
    ? devices.find((device) => device.id === selectedConnection.to)
    : null;

  const selectedConditions = {
    lossPct: selectedConnection?.conditions?.lossPct ?? 0,
    latencyMs: selectedConnection?.conditions?.latencyMs ?? 0,
    jitterMs: selectedConnection?.conditions?.jitterMs ?? 0,
    queueLimitPkts: selectedConnection?.conditions?.queueLimitPkts ?? 200,
    bandwidthPps: selectedConnection?.conditions?.bandwidthPps ?? 100,
    redEnabled: selectedConnection?.conditions?.redEnabled ?? false,
    redMinTh: selectedConnection?.conditions?.redMinTh ?? 80,
    redMaxTh: selectedConnection?.conditions?.redMaxTh ?? 150,
    redMaxDropPct: selectedConnection?.conditions?.redMaxDropPct ?? 30,
    blocked: selectedConnection?.conditions?.blocked ?? false,
  };

  const updateSelectedConditions = (fields) => {
    if (!selectedConnection) return;
    onUpdateConnection?.(selectedConnection.from, selectedConnection.to, {
      conditions: {
        ...selectedConditions,
        ...fields,
      },
    });
  };

  const applyPresetToSelectedLink = () => {
    if (!selectedConnection) return;
    const presetMap = {
      stable: {
        lossPct: 0,
        latencyMs: 10,
        jitterMs: 2,
        queueLimitPkts: 200,
        bandwidthPps: 1000,
        redEnabled: false,
        redMinTh: 80,
        redMaxTh: 150,
        redMaxDropPct: 30,
        blocked: false,
      },
      congested: {
        lossPct: 2,
        latencyMs: 120,
        jitterMs: 30,
        queueLimitPkts: 40,
        bandwidthPps: 20,
        redEnabled: true,
        redMinTh: 15,
        redMaxTh: 35,
        redMaxDropPct: 35,
        blocked: false,
      },
      hostile: {
        lossPct: 15,
        latencyMs: 260,
        jitterMs: 90,
        queueLimitPkts: 20,
        bandwidthPps: 8,
        redEnabled: true,
        redMinTh: 5,
        redMaxTh: 15,
        redMaxDropPct: 75,
        blocked: false,
      },
    };

    const preset = presetMap[linkPreset] || presetMap.stable;
    updateSelectedConditions(preset);
  };

  return (
    <div className="canvas-wrapper">
      {/* ── Palette ── */}
      <div className="palette">
        <div className="palette-title">Devices</div>
        <div className="palette-actions">
          <button className="palette-action-btn" onClick={expandAllGroups}>
            Expand all
          </button>
          <button className="palette-action-btn" onClick={collapseAllGroups}>
            Collapse all
          </button>
        </div>
        {PALETTE_GROUPS.map((group) => (
          <div key={group.title} className="palette-group">
            <button
              className="palette-group-toggle"
              onClick={() => toggleGroup(group.title)}
              title={collapsedGroups[group.title] ? "Expand section" : "Collapse section"}
            >
              <span className="palette-group-arrow">
                {collapsedGroups[group.title] ? "▸" : "▾"}
              </span>
              <span className="palette-group-title">{group.title}</span>
            </button>

            {!collapsedGroups[group.title] && group.devices.map((type) => (
              <div
                key={type}
                className="palette-item"
                draggable
                onDragStart={(e) => onPaletteDragStart(e, type)}
              >
                <span className="palette-icon">{DEVICE_ICONS[type]}</span>
                <span className="palette-name">
                  {DEVICE_LABELS[type] || type}
                </span>
              </div>
            ))}
          </div>
        ))}
        <hr className="palette-divider" />
        <button
          className={`btn-connect ${connectMode ? "active" : ""}`}
          onClick={() => (connectMode ? cancelConnect() : setConnectMode(true))}
        >
          {connectMode
            ? connectSource
              ? "▸ Pick target…"
              : "▸ Pick source…"
            : "⬡ Connect"}
        </button>
        {connectMode && (
          <>
            <div className="connect-dir-row">
              <button
                className={`connect-dir ${connectDirection === "both" ? "active" : ""}`}
                onClick={() => setConnectDirection("both")}
              >
                ↔
              </button>
              <button
                className={`connect-dir ${connectDirection === "forward" ? "active" : ""}`}
                onClick={() => setConnectDirection("forward")}
              >
                →
              </button>
              <button
                className={`connect-dir ${connectDirection === "reverse" ? "active" : ""}`}
                onClick={() => setConnectDirection("reverse")}
              >
                ←
              </button>
            </div>
            <div className="connect-dir-hint">
              {connectDirection === "both" && "Bi-directional"}
              {connectDirection === "forward" && "Outbound (source → target)"}
              {connectDirection === "reverse" && "Inbound (target → source)"}
            </div>
            <button className="btn-cancel" onClick={cancelConnect}>
              Cancel
            </button>
          </>
        )}

        <hr className="palette-divider" />
        <div className="link-editor">
          <div className="link-editor-title">Link</div>
          {!selectedConnection ? (
            <div className="link-editor-empty">Click a connection to edit.</div>
          ) : (
            <>
              <div className="link-editor-name">
                {selectedSource?.name || selectedConnection.from} → {selectedTarget?.name || selectedConnection.to}
              </div>
              <div className="link-editor-row">
                <select
                  className="link-editor-select"
                  value={linkPreset}
                  onChange={(e) => setLinkPreset(e.target.value)}
                >
                  <option value="stable">Stable</option>
                  <option value="congested">Congested</option>
                  <option value="hostile">Hostile</option>
                </select>
                <button className="link-editor-apply" onClick={applyPresetToSelectedLink}>
                  Apply
                </button>
              </div>
              <label className="link-editor-field">
                <span>Loss %</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectedConditions.lossPct}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    updateSelectedConditions({
                      lossPct: Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : 0,
                    });
                  }}
                />
              </label>
              <label className="link-editor-field">
                <span>Latency ms</span>
                <input
                  type="number"
                  min="0"
                  max="5000"
                  value={selectedConditions.latencyMs}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    updateSelectedConditions({
                      latencyMs: Number.isFinite(next) ? Math.max(0, Math.min(5000, next)) : 0,
                    });
                  }}
                />
              </label>
              <button
                className="link-editor-toggle"
                onClick={() => setAdvancedLinkControls((prev) => !prev)}
              >
                {advancedLinkControls ? "Hide advanced" : "Show advanced"}
              </button>
              {advancedLinkControls && (
                <>
              <label className="link-editor-field">
                <span>Jitter ms (±)</span>
                <input
                  type="number"
                  min="0"
                  max="2000"
                  value={selectedConditions.jitterMs}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    updateSelectedConditions({
                      jitterMs: Number.isFinite(next) ? Math.max(0, Math.min(2000, next)) : 0,
                    });
                  }}
                />
              </label>
              <label className="link-editor-field">
                <span>Queue capacity (pkts)</span>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={selectedConditions.queueLimitPkts}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    updateSelectedConditions({
                      queueLimitPkts: Number.isFinite(next) ? Math.max(1, Math.min(10000, Math.trunc(next))) : 200,
                    });
                  }}
                />
              </label>
              <label className="link-editor-field">
                <span>Bandwidth (pps)</span>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  value={selectedConditions.bandwidthPps}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    updateSelectedConditions({
                      bandwidthPps: Number.isFinite(next) ? Math.max(1, Math.min(100000, Math.trunc(next))) : 100,
                    });
                  }}
                />
              </label>
              <label className="link-editor-check">
                <input
                  type="checkbox"
                  checked={selectedConditions.redEnabled}
                  onChange={(e) => updateSelectedConditions({ redEnabled: e.target.checked })}
                />
                <span>RED early drop</span>
              </label>
              {selectedConditions.redEnabled && (
                <>
                  <label className="link-editor-field">
                    <span>RED min threshold</span>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={selectedConditions.redMinTh}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        updateSelectedConditions({
                          redMinTh: Number.isFinite(next) ? Math.max(0, Math.min(10000, Math.trunc(next))) : 80,
                        });
                      }}
                    />
                  </label>
                  <label className="link-editor-field">
                    <span>RED max threshold</span>
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      value={selectedConditions.redMaxTh}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        updateSelectedConditions({
                          redMaxTh: Number.isFinite(next) ? Math.max(1, Math.min(10000, Math.trunc(next))) : 150,
                        });
                      }}
                    />
                  </label>
                  <label className="link-editor-field">
                    <span>RED max drop %</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={selectedConditions.redMaxDropPct}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        updateSelectedConditions({
                          redMaxDropPct: Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : 30,
                        });
                      }}
                    />
                  </label>
                </>
              )}
              </>
              )}
              <label className="link-editor-check">
                <input
                  type="checkbox"
                  checked={selectedConditions.blocked}
                  onChange={(e) => updateSelectedConditions({ blocked: e.target.checked })}
                />
                <span>Blocked</span>
              </label>
            </>
          )}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div
        ref={canvasRef}
        className={`canvas-area ${connectMode ? "connect-mode" : ""}`}
        onDrop={onCanvasDrop}
        onDragOver={(e) => e.preventDefault()}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onClick={() => {
          setEditingId(null);
          setSelectedConnectionKey(null);
        }}
      >
        {/* SVG connection lines */}
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "auto",
            overflow: "visible",
          }}
        >
          <defs>
          </defs>
          {connections.map((conn, i) => {
            const src = devices.find((d) => d.id === conn.from);
            const dst = devices.find((d) => d.id === conn.to);
            if (!src || !dst) return null;
            const s = center(src);
            const t = center(dst);
            const m = { x: (s.cx + t.cx) / 2, y: (s.cy + t.cy) / 2 };
            const linkKey = `${conn.from}->${conn.to}`;
            const linkFlow = linkTrafficStats?.[linkKey] || {
              forward: 0,
              reverse: 0,
              dropped: 0,
              blocked: 0,
              queueDrops: 0,
              redDrops: 0,
            };
            const direction = conn.direction || "both";
            const conditions = conn.conditions || {};
            const conditionLabel = `${conditions.lossPct || 0}% · ${conditions.latencyMs || 0}±${conditions.jitterMs || 0}ms · bw${conditions.bandwidthPps || 100}pps · q${conditions.queueLimitPkts || 200}${conditions.redEnabled ? " · RED" : ""}${conditions.blocked ? " · BLOCK" : ""}`;
            const isSelected = selectedConnectionKey === linkKey;

            const dx = t.cx - s.cx;
            const dy = t.cy - s.cy;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const bend = 26;
            const topCtrl = { x: m.x + nx * bend, y: m.y + ny * bend };
            const bottomCtrl = { x: m.x - nx * bend, y: m.y - ny * bend };

            const inboundBadge = {
              x: t.cx + nx * 10,
              y: t.cy + ny * 10,
            };
            const outboundBadge = {
              x: s.cx - nx * 10,
              y: s.cy - ny * 10,
            };

            const inboundPath = `M ${s.cx} ${s.cy} Q ${topCtrl.x} ${topCtrl.y} ${t.cx} ${t.cy}`;
            const outboundPath = `M ${s.cx} ${s.cy} Q ${bottomCtrl.x} ${bottomCtrl.y} ${t.cx} ${t.cy}`;

            const inboundMuted = direction === "forward";
            const outboundMuted = direction === "reverse";

            return (
              <g key={i}>
                <path
                  d={inboundPath}
                  className={`conn-hit${isSelected ? " selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedConnectionKey(linkKey);
                  }}
                />
                <path
                  d={outboundPath}
                  className={`conn-hit${isSelected ? " selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedConnectionKey(linkKey);
                  }}
                />
                <path d={inboundPath} className={`conn-path conn-inbound${inboundMuted ? " muted" : ""}${isSelected ? " selected" : ""}`} />
                <path d={outboundPath} className={`conn-path conn-outbound${outboundMuted ? " muted" : ""}${isSelected ? " selected" : ""}`} />

                <text x={topCtrl.x} y={topCtrl.y - 8} textAnchor="middle" className="conn-label-in">
                  Inbound
                </text>
                <text x={bottomCtrl.x} y={bottomCtrl.y + 14} textAnchor="middle" className="conn-label-out">
                  Outbound
                </text>
                <text x={m.x} y={m.y + 4} textAnchor="middle" className={`conn-conditions${conditions.blocked ? " blocked" : ""}`}>
                  {conditionLabel}
                </text>

                <g transform={`translate(${inboundBadge.x}, ${inboundBadge.y})`}>
                  <rect x="-12" y="-9" width="24" height="14" rx="4" className="conn-badge-in" />
                  <text x="0" y="1" textAnchor="middle" className="conn-badge-text">{linkFlow.reverse}</text>
                </g>

                <g transform={`translate(${outboundBadge.x}, ${outboundBadge.y})`}>
                  <rect x="-12" y="-9" width="24" height="14" rx="4" className="conn-badge-out" />
                  <text x="0" y="1" textAnchor="middle" className="conn-badge-text">{linkFlow.forward}</text>
                </g>

                {linkFlow.dropped > 0 && (
                  <g transform={`translate(${m.x}, ${m.y - 12})`}>
                    <rect x="-18" y="-9" width="36" height="14" rx="4" className="conn-badge-drop" />
                    <text x="0" y="1" textAnchor="middle" className="conn-badge-text">-{linkFlow.dropped}</text>
                  </g>
                )}

                {linkFlow.queueDrops > 0 && (
                  <g transform={`translate(${m.x}, ${m.y + 16})`}>
                    <rect x="-20" y="-9" width="40" height="14" rx="4" className="conn-badge-queue" />
                    <text x="0" y="1" textAnchor="middle" className="conn-badge-text">q-{linkFlow.queueDrops}</text>
                  </g>
                )}

                {linkFlow.redDrops > 0 && (
                  <g transform={`translate(${m.x}, ${m.y + 32})`}>
                    <rect x="-18" y="-9" width="36" height="14" rx="4" className="conn-badge-red" />
                    <text x="0" y="1" textAnchor="middle" className="conn-badge-text">r-{linkFlow.redDrops}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Device nodes */}
        {devices.map((device) => (
          <div
            key={device.id}
            className={`device-node device-${device.type}${
              connectSource === device.id ? " connect-source" : ""
            }`}
            style={{ left: device.x, top: device.y, width: NODE_W, height: NODE_H }}
            onMouseDown={(e) => onDeviceMouseDown(e, device)}
            onClick={(e) => onDeviceClick(e, device)}
          >
            <button
              className="device-delete"
              title="Remove device"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveDevice(device.id);
              }}
            >
              ×
            </button>
            <span className="device-icon">{DEVICE_ICONS[device.type]}</span>
            <div className="device-info">
              <div className="device-name">{device.name}</div>
              <div className="device-traffic">
                <span className="traffic-out">↑ {(trafficStats?.[device.id]?.outbound) || 0}</span>
                <span className="traffic-in">↓ {(trafficStats?.[device.id]?.inbound) || 0}</span>
              </div>
              {editingId === device.id ? (
                <div
                  className="ip-edit"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    autoFocus
                    className="ip-input"
                    value={editIpValue}
                    placeholder="192.168.1.x"
                    onChange={(e) => setEditIpValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitIp(device.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button className="ip-save" onClick={() => commitIp(device.id)}>
                    ✓
                  </button>
                </div>
              ) : (
                <div className="device-ip" title="Click to assign IP">
                  {device.ip || (
                    <span className="ip-placeholder">set IP…</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {devices.length === 0 && (
          <div className="canvas-empty">
            ← Drag a device onto the canvas to begin
          </div>
        )}
      </div>
    </div>
  );
}
