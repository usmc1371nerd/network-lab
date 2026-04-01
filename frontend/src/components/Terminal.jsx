
import React, { useState, useRef, useEffect } from "react";
import axios from "axios";

const PROMPT = "lab@network:~$";
const MAX_CAPTURE_SHOW_ROWS = 100;

export default function Terminal({
  devices,
  packets,
  onAppendPackets,
  onClearPackets,
  onShowPackets,
}) {
  const [history, setHistory] = useState([
    { type: "info", text: 'Network Lab Terminal — type "help" for usage.' },
    { type: "info", text: "Capture is OFF (use: tcpdump start)" },
  ]);
  const [input, setInput] = useState("");
  const [cmdHistory, setCmdHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const getTerminalText = () => history.map((line) => line.text).join("\n");

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      pushLines(["Copied to clipboard."], "info");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      pushLines(["Copied to clipboard."], "info");
    }
  };

  const copySelectionOrLog = async () => {
    const selected = window.getSelection()?.toString().trim();
    const text = selected && selected.length > 0 ? selected : getTerminalText();
    if (!text) {
      pushLines(["Nothing to copy."], "info");
      return;
    }
    await copyText(text);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        pushLines(["Clipboard is empty."], "info");
        return;
      }
      setInput((prev) => `${prev}${text}`);
      inputRef.current?.focus();
    } catch {
      pushLines(["Clipboard paste not allowed in this browser context."], "error");
    }
  };

  const onTerminalKeyDown = async (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      await copySelectionOrLog();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      await pasteFromClipboard();
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const pushLines = (lines, type = "output") => {
    setHistory((prev) => [
      ...prev,
      ...lines.map((text) => ({ type, text })),
    ]);
  };

  const runCommand = async (cmd) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    // echo command
    setHistory((prev) => [
      ...prev,
      { type: "cmd", text: `${PROMPT} ${trimmed}` },
    ]);
    setCmdHistory((prev) => [trimmed, ...prev]);
    setHistIdx(-1);

    if (trimmed === "clear") {
      setHistory([]);
      return;
    }

    if (trimmed === "ip addr" || trimmed === "ip a") {
      if (devices.length === 0) {
        pushLines(["No interfaces configured."], "info");
      } else {
        const lines = [];
        devices.forEach((device, index) => {
          lines.push(`${index + 1}: ${device.name.toLowerCase()}: <UP> mtu 1500`);
          lines.push(`    inet ${device.ip || "unassigned"} scope global ${device.name.toLowerCase()}`);
        });
        pushLines(lines);
      }
      return;
    }

    if (trimmed === "ip route") {
      const routed = devices
        .filter((device) => device.ip)
        .map((device) => {
          const octets = device.ip.split(".");
          if (octets.length !== 4) return null;
          return `${octets[0]}.${octets[1]}.${octets[2]}.0/24 dev ${device.name.toLowerCase()}`;
        })
        .filter(Boolean);

      if (routed.length === 0) {
        pushLines(["No routes configured."], "info");
      } else {
        pushLines(Array.from(new Set(routed)));
      }
      return;
    }

    const captureMatch = trimmed.match(/^(capture|tcpdump)\s+(start|stop|clear|show|status)$/i);
    if (captureMatch) {
      const action = captureMatch[2].toLowerCase();
      if (action === "start") {
        if (captureEnabled) {
          pushLines(["Capture is already running."], "info");
        } else {
          setCaptureEnabled(true);
          pushLines(["Capture started."], "info");
        }
      } else if (action === "stop") {
        if (!captureEnabled) {
          pushLines(["Capture is already stopped."], "info");
        } else {
          setCaptureEnabled(false);
          pushLines(["Capture stopped."], "info");
        }
      } else if (action === "clear") {
        onClearPackets();
        pushLines(["Capture buffer cleared."], "info");
      } else if (action === "show") {
        onShowPackets();
        if (packets.length === 0) {
          pushLines(["No captured packets."], "info");
        } else {
          const visibleRows = packets.slice(-MAX_CAPTURE_SHOW_ROWS);
          const header = [
            `Captured packets: ${packets.length}`,
            "No.    Time       Source            Destination       Proto  Len  Info",
          ];
          const rows = visibleRows.map((packet) => {
            const no = String(packet.no ?? "").padEnd(6, " ");
            const time = String(packet.time ?? "").padEnd(10, " ");
            const src = String(packet.src ?? "").slice(0, 16).padEnd(16, " ");
            const dst = String(packet.dst ?? "").slice(0, 16).padEnd(16, " ");
            const proto = String(packet.protocol ?? "").padEnd(6, " ");
            const len = String(packet.len ?? "").padEnd(4, " ");
            const info = String(packet.info ?? "");
            return `${no}${time}${src}${dst}${proto}${len}${info}`;
          });
          const note =
            packets.length > MAX_CAPTURE_SHOW_ROWS
              ? [`Showing last ${MAX_CAPTURE_SHOW_ROWS} packets.`]
              : [];
          pushLines([...header, ...rows, ...note, "Packet log panel updated."], "info");
        }
      } else if (action === "status") {
        pushLines([
          captureEnabled ? "tcpdump: capture running" : "tcpdump: capture stopped",
          `buffered packets: ${packets.length}`,
        ], "info");
      }
      return;
    }

    if (trimmed === "help") {
      pushLines([
        "Available commands:",
        "  ping <ip> [-c N]         - send ICMP echo requests",
        "  ip addr | ip a           - show device interfaces",
        "  ip route                 - show basic routes",
        "  tcpdump start|stop       - control packet capture",
        "  tcpdump clear|show       - clear/show capture buffer",
        "  tcpdump status           - show capture state",
        "  capture ...              - alias of tcpdump",
        "  help                     - show this help message",
        "  clear                    - clear terminal output",
      ]);
      return;
    }

    setLoading(true);
    try {
      const res = await axios.post("/api/run-command", {
        command: trimmed,
        devices,
      });
      const { output = [], packets = [] } = res.data;
      pushLines(output);
      if (captureEnabled && packets.length > 0) onAppendPackets(packets);
    } catch (err) {
      pushLines([`Error: ${err.message}`], "error");
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      runCommand(input);
      setInput("");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx + 1, cmdHistory.length - 1);
      setHistIdx(next);
      setInput(cmdHistory[next] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histIdx - 1, -1);
      setHistIdx(next);
      setInput(next === -1 ? "" : cmdHistory[next] || "");
    }
  };

  return (
    <div className="terminal" onKeyDown={onTerminalKeyDown}>
      <div className="terminal-output">
        {history.map((line, i) => (
          <div key={i} className={`terminal-line line-${line.type}`}>
            {line.text}
          </div>
        ))}
        {loading && (
          <div className="terminal-line line-info">Running…</div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="terminal-input-row">
        <button className="terminal-tool" onClick={copySelectionOrLog} disabled={loading}>
          Copy Log
        </button>
        <button className="terminal-tool" onClick={pasteFromClipboard} disabled={loading}>
          Paste
        </button>
        <span className="terminal-prompt">{PROMPT}</span>
        <input
          ref={inputRef}
          className="terminal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder='ping 192.168.1.x'
          spellCheck={false}
          autoComplete="off"
          disabled={loading}
        />
      </div>
    </div>
  );
}
