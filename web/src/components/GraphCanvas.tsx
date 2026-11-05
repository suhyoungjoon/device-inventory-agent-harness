import dagre from "@dagrejs/dagre";
import {
  BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import type { WorkflowEdge, WorkflowNode } from "../types";
import { L } from "../terms";

// 서버가 컴파일한 LangGraph 그래프(get_graph의 노드·연결)를 왼쪽→오른쪽으로 자동 배치해 그린다 (M11).
// 되돌아가는 연결은 노드 아래로 도는 곡선, 자기 자신으로 돌아가는 연결은 노드 위의 고리로 그린다.

export interface NodeView {
  state?: "idle" | "next" | "running" | "done" | "error" | "waiting";
  badge?: string;        // 예: "3회"
  summary?: string;      // 노드 아래 한 줄
  selected?: boolean;
}

interface CardData extends Record<string, unknown> {
  node: WorkflowNode;
  view: NodeView;
  terminal: boolean;
  showIds: boolean;
}

const MARK = { done: "✓", next: "▶", running: "…", error: "✕", waiting: "⏸", idle: "" } as const;
const KIND_NAME: Record<string, string> = { ai: "AI", rule: "규칙 계산", human: "사람", tool: "도구·흐름", check: "검사" };

function Card({ data }: NodeProps<Node<CardData>>) {
  const { node, view, terminal, showIds } = data;
  const handles = (
    <>
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="bs" style={{ left: "65%" }} />
      <Handle type="target" position={Position.Bottom} id="bt" style={{ left: "35%" }} />
      <Handle type="source" position={Position.Top} id="ts" style={{ left: "70%" }} />
      <Handle type="target" position={Position.Top} id="tt" style={{ left: "30%" }} />
    </>
  );
  if (terminal) {
    return <div className="gc-terminal">{handles}{node.id === "__start__" ? "시작" : "끝"}</div>;
  }
  const st = view.state ?? "idle";
  return (
    <div className={`gc-card gc-${node.kind ?? "rule"} gc-${st}${view.selected ? " gc-selected" : ""}`}
      title={node.description ?? node.id}>
      {handles}
      <div className="gc-head">
        {MARK[st] && <span className="gc-mark" aria-hidden>{MARK[st]}</span>}
        <strong>{L(node.label ?? node.id)}</strong>
        {view.badge && <span className="gc-badge">{view.badge}</span>}
      </div>
      {showIds && (
        <div className="gc-sub">
          <span className="gc-kind">{(node as { agent?: boolean }).agent ? "AI 에이전트" : KIND_NAME[node.kind ?? "rule"] ?? ""}</span>
          <code>{node.id}</code>
        </div>
      )}
      {view.summary && <div className="gc-summary">{view.summary}</div>}
    </div>
  );
}

// 자기 자신으로 돌아가는 연결 (예: 미리 돌려보기 → 다음 제안 → 미리 돌려보기)
function SelfLoop({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, label }: EdgeProps) {
  const h = 46;
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 20} ${sourceY - h}, ${targetX - 20} ${targetY - h}, ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div className="gc-edge-label" style={{ transform: `translate(-50%, -100%) translate(${(sourceX + targetX) / 2}px, ${sourceY - h + 4}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// 실행 중인 노드로 화면을 옮긴다 (그래프가 화면보다 넓을 때 글자를 줄이지 않고 따라간다)
function Follow({ id }: { id?: string | null }) {
  const rf = useReactFlow();
  useEffect(() => {
    if (!id) return;
    const timer = setTimeout(() => {
      const n = rf.getNode(id);
      if (!n) return;
      if (id === "__start__") {   // 시작은 왼쪽 끝에 맞춘다 (실행 전 첫 화면)
        const { y, zoom } = rf.getViewport();
        rf.setViewport({ x: 16 - n.position.x * zoom, y, zoom }, { duration: 300 });
        return;
      }
      rf.setCenter(n.position.x + (n.width ?? 0) / 2, n.position.y + (n.height ?? 0) / 2,
        { zoom: rf.getViewport().zoom, duration: 500 });
    }, 80);
    return () => clearTimeout(timer);
  }, [id, rf]);
  return null;
}

const nodeTypes = { card: Card };
const edgeTypes = { self: SelfLoop };

export default function GraphCanvas({
  nodes,
  edges,
  views = {},
  activeEdges = new Set<string>(),
  onNodeClick,
  height = 260,
  nodeWidth = 170,
  nodeHeight = 70,
  ariaLabel,
  follow,
  minFitZoom = 0.5,
  padding = 0.16,
  showIds = true,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  views?: Record<string, NodeView>;
  activeEdges?: Set<string>;          // "source->target": 방금 지나간 연결 (움직이는 선)
  onNodeClick?: (id: string) => void;
  height?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  ariaLabel: string;
  follow?: string | null;   // 이 노드로 화면을 옮긴다 (바뀔 때마다)
  minFitZoom?: number;      // 전체 맞춤의 최소 배율. 이보다 작아져야 다 들어가면 일부만 보이고 끌어서 이동
  padding?: number;         // 전체 맞춤 여백 (아래로 도는 되돌림 선이 잘리지 않게)
  showIds?: boolean;        // 카드에 노드 종류·id 표시 (끄면 이름만. 에이전트 탭의 쉬운 보기)
}) {
  // 구조(노드·연결)가 바뀔 때만 다시 배치한다 (하네스 레벨을 바꾸면 배정 에이전트 그래프가 다시 배치된다)
  const shape = JSON.stringify([nodes.map((n) => n.id), edges.map((e) => [e.source, e.target])]);
  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 84, marginx: 10, marginy: 10 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) {
      const terminal = n.id.startsWith("__");
      g.setNode(n.id, { width: terminal ? 46 : nodeWidth, height: terminal ? 30 : nodeHeight });
    }
    // 노드는 흐름 순서대로 온다 (서버가 그 순서로 add_node). 순서상 뒤로 가는 연결은 배치 계산에서만 뒤집어
    // 주 흐름이 왼쪽→오른쪽으로 곧게 서게 한다 (그림의 화살표 방향은 그대로)
    const order = new Map(nodes.map((n, i) => [n.id, n.id === "__end__" ? nodes.length : i]));
    for (const e of edges) {
      if (e.source === e.target) continue;
      const forward = (order.get(e.source) ?? 0) < (order.get(e.target) ?? 0);
      if (forward) g.setEdge(e.source, e.target, { weight: e.conditional ? 1 : 3 });
      else g.setEdge(e.target, e.source, { weight: 1 });
    }
    dagre.layout(g);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      const p = g.node(n.id);
      pos[n.id] = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
    }
    return pos;
  }, [shape, nodeWidth, nodeHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  // 크기를 정해 두고 측정된 것으로 알려 준다 (다시 그릴 때 React Flow가 노드를 숨기지 않게)
  const size = (id: string) => (id.startsWith("__") ? { width: 46, height: 30 } : { width: nodeWidth, height: nodeHeight });
  const rfNodes: Node<CardData>[] = nodes.map((n) => ({
    id: n.id, type: "card", position: layout[n.id] ?? { x: 0, y: 0 }, ...size(n.id), measured: size(n.id),
    data: { node: n, view: views[n.id] ?? {}, terminal: n.id.startsWith("__"), showIds },
    draggable: false, connectable: false, selectable: false,
  }));

  // 되돌아가는 연결은 노드 아래 같은 띠를 지나 라벨이 겹친다: 라벨은 마우스를 올렸을 때와 방금 지나갔을 때만 보인다
  const [hovered, setHovered] = useState<string | null>(null);
  // 같은 두 노드 사이 되돌아가는 연결이 여러 개면 곡선 높이를 조금씩 다르게
  let back = 0;
  const rfEdges: Edge[] = edges.map((e) => {
    const key = `${e.source}->${e.target}`;
    const active = activeEdges.has(key);
    const self = e.source === e.target;
    const backward = !self && (layout[e.target]?.x ?? 0) < (layout[e.source]?.x ?? 0);
    const color = active ? "var(--series-1)" : "var(--axis)";
    const style = { stroke: color, strokeWidth: active ? 2.5 : 1.4, strokeDasharray: e.conditional ? "5 4" : undefined };
    const base: Edge = {
      id: key + (e.label ?? ""), source: e.source, target: e.target, animated: active,
      label: e.label ?? undefined, style, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      labelStyle: { fontSize: 10, fill: "var(--text-secondary)" },
      labelBgStyle: { fill: "var(--surface)" }, labelBgPadding: [3, 1] as [number, number],
      className: active ? "gc-edge-active" : undefined,
    };
    if (self) return { ...base, type: "self", sourceHandle: "ts", targetHandle: "tt" };
    if (backward) {
      back += 1;
      const showLabel = active || hovered === base.id;
      return { ...base, label: showLabel ? base.label : undefined, type: "smoothstep", sourceHandle: "bs", targetHandle: "bt",
        pathOptions: { offset: 18 + back * 10, borderRadius: 12 } } as Edge;
    }
    return { ...base, type: "default", sourceHandle: "r", targetHandle: "l" };
  });

  return (
    <div className="gc-canvas" style={{ height }} role="figure" aria-label={ariaLabel}>
      <ReactFlow key={shape} nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        fitView fitViewOptions={{ padding, minZoom: minFitZoom, maxZoom: 1.1 }} minZoom={0.3} maxZoom={1.6}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        zoomOnScroll={false} preventScrolling={false} panOnScroll={false}
        onNodeClick={(_, n) => onNodeClick?.(n.id)}
        onEdgeMouseEnter={(_, e) => setHovered(e.id)} onEdgeMouseLeave={() => setHovered(null)}>
        <Controls showInteractive={false} position="bottom-right" />
        <Follow id={follow} />
      </ReactFlow>
    </div>
  );
}
