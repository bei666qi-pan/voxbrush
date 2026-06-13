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
  | { op: 'generate_image'; prompt: string; as: 'background' | 'object'; x?: number; y?: number; w?: number; h?: number }
  // 风格化渲染层：把当前矢量画布快照作条件图，经 Seedream img2img 输出整幅风格皮肤，
  // 铺为 z=-50 背景渲染层；矢量对象保留在上层继续可编辑。style='none' 表示去掉风格还原。
  | { op: 'render_style'; style: string; strength?: number }
  // 物体级 AI 重绘：把已寻址的对象替换成 AI 生成图（在其原位置/尺寸落图，删除原对象）。
  // 利用「对象可寻址」优势，如「把那棵树变成真实的樱花树」。
  | { op: 'regen'; target?: Target; prompt: string };

export interface SceneState {
  nodes: Node[];
  background: string;
  selectedId: string | null;
  lastId: string | null;
}

/** 对话历史条目（用于多轮上下文消解） */
export interface HistoryEntry {
  utterance: string;
  /** 最近一轮 add 操作的摘要：shape/asset/颜色/大致位置 */
  lastAdd?: {
    shape: Shape;
    asset?: string;
    fill?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    r?: number;
    name?: string;
    palette?: string[];
  };
  /** 该轮涉及的对象 ID 列表 */
  objectIds: string[];
  /** 该轮产生的所有 ops 摘要（用于代词消解） */
  opsSummary?: string;
}

/** 语音宏定义（localStorage 持久化） */
export interface VoiceMacro {
  name: string;
  entries: {
    shape: Shape;
    asset?: string;
    dx: number;  // 相对宏中心的 x 偏移
    dy: number;  // 相对宏中心的 y 偏移
    w: number;
    h: number;
    r?: number;
    fill?: string;
    palette?: string[];
    name?: string;
    z?: number;
  }[];
}

export const CANVAS_W = 960;
export const CANVAS_H = 600;
