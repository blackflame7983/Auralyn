const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUTPUT_PATH = path.join(__dirname, '../docs/documentation_diagrams.drawio');
const OUTPUT_DIR = path.dirname(OUTPUT_PATH);

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function createDiagramXml(nodes, edges) {
    let xml = '<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">';
    xml += '<root><mxCell id="0"/><mxCell id="1" parent="0"/>';

    nodes.forEach(n => {
        // Flat Design Style
        let baseStyle = n.style || 'rounded=1;whiteSpace=wrap;html=1;arcSize=20;strokeWidth=0;shadow=1;fontFamily=Segoe UI, Meiryo, sans-serif;fontSize=14;fontColor=#333333;';
        xml += `<mxCell id="${n.id}" value="${n.label}" style="${baseStyle}" vertex="1" parent="1">`;
        xml += `<mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`;
    });

    edges.forEach(e => {
        let edgeStyle = e.style || 'edgeStyle=orthogonalEdgeStyle;rounded=1;jumpStyle=arc;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#555555;strokeWidth=2;endArrow=block;endFill=1;';
        xml += `<mxCell id="${e.id}" value="${e.label || ''}" style="${edgeStyle}" edge="1" parent="1" source="${e.source}" target="${e.target}">`;
        xml += `<mxGeometry relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>`;
    });

    xml += '</root></mxGraphModel>';
    return xml;
}

function compress(xml) {
    const encoded = encodeURIComponent(xml);
    return zlib.deflateRawSync(encoded).toString('base64');
}

function generateDrawioFile(diagrams) {
    let output = '<mxfile host="Electron" modified="' + new Date().toISOString() + '" agent="Agent" type="device" version="14.6.13">';
    diagrams.forEach(d => {
        output += `<diagram id="${d.id}" name="${d.name}">${compress(d.xml)}</diagram>`;
    });
    output += '</mxfile>';
    return output;
}

// Colors (Pastel / Flat)
const C_MIC = 'fillColor=#C8E6C9;fontColor=#2E7D32;'; // Light Green
const C_APP = 'fillColor=#FFF9C4;fontColor=#F57F17;gradientColor=#FFF176;'; // Yellow/Orange Gradient
const C_DEV = 'fillColor=#E1F5FE;fontColor=#0277BD;'; // Light Blue
const C_OUT = 'fillColor=#F3E5F5;fontColor=#7B1FA2;'; // Light Purple
const C_HW = 'fillColor=#F5F5F5;fontColor=#424242;strokeColor=#BDBDBD;strokeWidth=1;'; // Grey

// --- Diagram 1: Overall Overview (全体概要) ---
const nodes1 = [
    { id: 'src', label: '🎤\nマイク / 音楽', x: 40, y: 120, w: 120, h: 80, style: `ellipse;whiteSpace=wrap;html=1;${C_MIC}` },
    { id: 'in', label: '🔌\n入力デバイス', x: 240, y: 130, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;arcSize=50;${C_DEV}` },
    { id: 'vst', label: '✨ Auralyn ✨\n(音を加工)', x: 460, y: 110, w: 160, h: 100, style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.1;${C_APP}` },
    { id: 'out', label: '🔈\n出力デバイス', x: 700, y: 130, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;arcSize=50;${C_DEV}` },
    { id: 'dst', label: '🎧\n自分 / 視聴者', x: 920, y: 120, w: 120, h: 80, style: `ellipse;whiteSpace=wrap;html=1;${C_OUT}` }
];
const edges1 = [
    { id: 'e1', source: 'src', target: 'in', label: '音が入る' },
    { id: 'e2', source: 'in', target: 'vst' },
    { id: 'e3', source: 'vst', target: 'out' },
    { id: 'e4', source: 'out', target: 'dst', label: '音が聞こえる' }
];

// --- Diagram 2: Hardware Mixer Setup (機材使用) ---
const nodes2 = [
    { id: 'mic', label: '🎤\nマイク', x: 40, y: 100, w: 100, h: 80, style: `ellipse;whiteSpace=wrap;html=1;${C_MIC}` },

    // Hardware Container
    { id: 'hw', label: '🎛️ オーディオミキサー\n(AG03 / GoXLR など)', x: 200, y: 40, w: 200, h: 260, style: `swimlane;startSize=40;rounded=1;arcSize=10;html=1;${C_HW}collapsible=0;` },

    // Inside hardware mixer
    { id: 'usb_out', label: '⬆️ USB出力\n(Stream/Line)', x: 230, y: 100, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#DDDDDD;strokeWidth=1;fontColor=#555555;` },
    { id: 'mix_loop', label: '🔄 ループバック\n(PC音 + マイク)', x: 230, y: 220, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#DDDDDD;strokeWidth=1;fontColor=#555555;` },

    // App
    { id: 'app', label: '✨ Auralyn ✨\n(加工する)', x: 500, y: 100, w: 140, h: 80, style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.1;${C_APP}` },

    // Return path
    { id: 'usb_in', label: '⬇️ USB入力\n(Loopbackへ)', x: 500, y: 220, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;${C_DEV}` },

    // OBS
    { id: 'obs', label: '📡 配信ソフト\n(OBS / Discord)', x: 200, y: 360, w: 200, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;${C_OUT}` }
];

const edges2 = [
    { id: 'edge_mic', source: 'mic', target: 'hw', label: '接続' },
    { id: 'edge_usb1', source: 'usb_out', target: 'app', label: 'USBで入力', style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#555555;strokeWidth=2;entryX=0;entryY=0.5;' },
    { id: 'edge_ret', source: 'app', target: 'usb_in', label: 'USBで戻す' },
    { id: 'edge_loop', source: 'usb_in', target: 'mix_loop', label: 'PC音が戻る', style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;strokeColor=#555555;strokeWidth=2;' },
    { id: 'edge_final', source: 'mix_loop', target: 'obs', style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#555555;strokeWidth=2;exitX=0.5;exitY=1;entryX=0.5;entryY=0;' }
];

// --- Diagram 3: VB-Cable Setup (ソフト使用) ---
const nodes3 = [
    { id: 'mic', label: '🎤\nUSBマイク', x: 40, y: 120, w: 120, h: 80, style: `ellipse;whiteSpace=wrap;html=1;${C_MIC}` },
    { id: 'app', label: '✨ Auralyn ✨\n(声質を調整)', x: 240, y: 120, w: 140, h: 80, style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.1;${C_APP}` },

    // Grouping VB-Cable visually
    { id: 'cb_in', label: '📥 VB-Cable Input\n(ケーブル入口)', x: 460, y: 130, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;arcSize=20;${C_DEV}` },
    { id: 'cb_out', label: '📤 VB-Cable Output\n(ケーブル出口)', x: 700, y: 130, w: 140, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;arcSize=20;${C_DEV}` },

    { id: 'obs', label: '📡 配信ソフト\n(OBS / Discord)', x: 920, y: 120, w: 140, h: 80, style: `rounded=1;whiteSpace=wrap;html=1;${C_OUT}` }
];
const edges3 = [
    { id: 'e1', source: 'mic', target: 'app', label: '直接入力\n(遅延なし)' },
    { id: 'e2', source: 'app', target: 'cb_in', label: '加工後の音' },
    { id: 'e3', source: 'cb_in', target: 'cb_out', label: '内部接続', style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;dashed=1;strokeColor=#888888;' },
    { id: 'e4', source: 'cb_out', target: 'obs', label: 'マイク入力として選択' }
];

// --- Diagram 4: Music Playback (音楽再生) ---
const nodes4 = [
    { id: 'player', label: '🎵 音楽プレイヤー\n(Spotify / YouTube)', x: 40, y: 120, w: 160, h: 80, style: `rounded=1;whiteSpace=wrap;html=1;fillColor=#FFEBEE;fontColor=#C62828;strokeColor=#EF9A9A;strokeWidth=0;` },

    { id: 'cb_a_in', label: '📥 Cable Input', x: 280, y: 130, w: 120, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;${C_DEV}` },
    { id: 'cb_a_out', label: '📤 Cable Output', x: 450, y: 130, w: 120, h: 60, style: `rounded=1;whiteSpace=wrap;html=1;${C_DEV}` },

    { id: 'app', label: '✨ Auralyn ✨\n(音楽を加工)', x: 650, y: 120, w: 140, h: 80, style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.1;${C_APP}` },
    { id: 'spk', label: '🔈 スピーカー\n🎧 ヘッドホン', x: 880, y: 120, w: 140, h: 80, style: `ellipse;whiteSpace=wrap;html=1;${C_MIC}` }
];
const edges4 = [
    { id: 'e1', source: 'player', target: 'cb_a_in', label: '出力先を\nケーブルに設定' },
    { id: 'e2', source: 'cb_a_in', target: 'cb_a_out', style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;strokeColor=#888888;' },
    { id: 'e3', source: 'cb_a_out', target: 'app', label: 'ケーブル経由で\n音を受け取る' },
    { id: 'e4', source: 'app', target: 'spk', label: '加工して出力' }
];

const diagrams = [
    { id: 'd1', name: 'Overview', xml: createDiagramXml(nodes1, edges1) },
    { id: 'd2', name: 'Hardware Mixer', xml: createDiagramXml(nodes2, edges2) },
    { id: 'd3', name: 'Software Setup', xml: createDiagramXml(nodes3, edges3) },
    { id: 'd4', name: 'Music Playback', xml: createDiagramXml(nodes4, edges4) }
];

const fileContent = generateDrawioFile(diagrams);
fs.writeFileSync(OUTPUT_PATH, fileContent);
console.log(`Generated ${OUTPUT_PATH}`);
