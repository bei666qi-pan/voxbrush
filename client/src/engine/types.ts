export type Shape =
  | 'circle' | 'ellipse' | 'rect' | 'triangle' | 'line' | 'arrow'
  | 'star' | 'heart' | 'polygon' | 'text'
  | 'path'      // SVG path 数据（d），支持贝塞尔曲线
  | 'sprite'    // 语义素材库组件（asset: house/tree/...）
  | 'image';    // 位图（Seedream 生成或外链）

export interface Gradient {
  type: 'linear' | 'radial';
  stops: [number, string][];      // [offset 0~1, color]
  angle?: number;                  // linear 渐变角度（度）
}

export interface Shadow { blur: number; color: string; dx?: number; dy?: number; }

export interface Node {
  id: string;
  shape: Shape;
  name?: string;
  x: number; y: number;          // 中心
  w?: number; h?: number; r?: number;
  x2?: number; y2?: number;      // line/arrow 终点
  points?: [number, number][];   // polygon
  sides?: number;
  rotation?: number;
  fill?: string;
  gradient?: Gradient;           // 优先于 fill
  stroke?: string;
  strokeWidth?: number;
  shadow?: Shadow;
  opacity?: number;
  z?: number;                    // 层级（小在下，默认按加入顺序）
  text?: string;
  fontSize?: number;
  d?: string;                    // path：SVG path 数据（以 x,y 为原点，建议 -100~100 设计坐标）
  asset?: string;                // sprite：素材名（house/tree/...）
  palette?: string[];            // sprite：主题色覆盖
  src?: string;                  // image：URL 或 dataURL
  bornAt?: number;               // 入场动画
}

export interface Target {
  kind: 'last' | 'selected' | 'name' | 'query';
  name?: string;
  shape?: Shape;
  color?: string;
  position?: 'left' | 'right' | 'top' | 'bottom' | 'center';
  index?: number;
}

export type Op =
  | { op: 'add'; shape: Shape; props: Partial<Node> }
  | { op: 'modify'; target?: Target; set?: Partial<Node>; delta?: { dx?: number; dy?: number; scale?: number; rotate?: number } }
  | { op: 'delete'; target?: Target }
  | { op: 'select'; target?: Target }
  | { op: 'undo' } | { op: 'redo' } | { op: 'clear' }
  | { op: 'background'; color: string }
  | { op: 'save' }
  | { op: 'say'; text: string }
  | { op: 'help' }
  | { op: 'generate_image'; prompt: string; as: 'background' | 'object'; x?: number; y?: number; w?: number; h?: number };

export interface SceneState {
  nodes: Node[];
  background: string;
  selectedId: string | null;
  lastId: string | null;
}

export const CANVAS_W = 960;
export const CANVAS_H = 600;
