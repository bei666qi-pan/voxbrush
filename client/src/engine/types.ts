export type Shape =
  | 'circle' | 'ellipse' | 'rect' | 'triangle' | 'line' | 'arrow'
  | 'star' | 'heart' | 'polygon' | 'text';

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
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
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
  | { op: 'help' };

export interface SceneState {
  nodes: Node[];
  background: string;
  selectedId: string | null;
  lastId: string | null;
}

export const CANVAS_W = 960;
export const CANVAS_H = 600;
