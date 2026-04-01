
import React, { useState, useRef } from "react";

const DEVICE_ICONS = { pc: "💻", server: "🖥️", router: "📡", switch: "🔀" };
const PALETTE = ["pc", "server", "router", "switch"];
const NODE_W = 136;
const NODE_H = 68;

export default function NetworkCanvas({
  devices,
  connections,
  onAddDevice,
  onUpdateDevice,
  onRemoveDevice,
  onAddConnection,
}) {
  const canvasRef = useRef(null);
  const draggingRef = useRef(null);

  const [connectMode, setConnectMode] = useState(false);
  const [connectSource, setConnectSource] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editIpValue, setEditIpValue] = useState("");

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
        onAddConnection(connectSource, device.id);
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

  return (
    <div className="canvas-wrapper">
      {/* ── Palette ── */}
      <div className="palette">
        <div className="palette-title">Devices</div>
        {PALETTE.map((type) => (
          <div
            key={type}
            className="palette-item"
            draggable
            onDragStart={(e) => onPaletteDragStart(e, type)}
          >
            <span className="palette-icon">{DEVICE_ICONS[type]}</span>
            <span className="palette-name">
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </span>
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
          <button className="btn-cancel" onClick={cancelConnect}>
            Cancel
          </button>
        )}
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
        onClick={() => setEditingId(null)}
      >
        {/* SVG connection lines */}
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="8"
              markerHeight="6"
              refX="8"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#4ade80" />
            </marker>
          </defs>
          {connections.map((conn, i) => {
            const src = devices.find((d) => d.id === conn.from);
            const dst = devices.find((d) => d.id === conn.to);
            if (!src || !dst) return null;
            const s = center(src);
            const t = center(dst);
            return (
              <line
                key={i}
                x1={s.cx}
                y1={s.cy}
                x2={t.cx}
                y2={t.cy}
                className="conn-line"
              />
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
