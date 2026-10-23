import type { CSSProperties } from "react";

/**
 * 探针 · Probe —— 品牌锁标
 *
 * 只用代码画：一条极细白色探针轴线 + 轴线上三个逐级变小的实心蓝点，
 * 表示"沿一条线持续采样、置信度收敛"。没有任何外链图片。
 *
 * 几何全部由参数推导，不手写坐标：
 *   轴线左下 → 右上，三个节点按 t ∈ (0,1) 在轴上求值，
 *   永远落在线上（改轴、改点位都不会跑偏）。
 *
 * 缩放：唯一的尺寸旋钮是 `size`（字标字号）。图形、副标题、间距都用 em 派生，
 * 所以传 16 / 22 / "clamp(15px,1.4vw,19px)" 都能整体等比缩放。
 */

export type ProbeLogoProps = {
  /** 字标字号，数字按 px 处理；其余长度（rem / clamp）原样透传。默认 16。 */
  size?: number | string;
  /** horizontal = 放进 Header 左上角；vertical = 参考稿那种上图下字（启动页 / 分享卡）。 */
  orientation?: "horizontal" | "vertical";
  /**
   * 节点色。默认 #3b82f6 —— 与全站强调色同色、与纯黑底对比 5.7:1。
   * 旧值 #0055FF 是更深的蓝，压在纯黑上只有 3.7:1，蓝点会「陷」进背景。
   */
  nodeColor?: string;
  /** 轴线色。默认 90% 白。 */
  lineColor?: string;
  /** 副标题文案；传 null 只留图形 + PROBE。 */
  subtitle?: string | null;
  className?: string;
};

/** 探针轴线：40×40 画布内留白 4，从左下走到右上。 */
const AXIS = { x1: 4, y1: 36, x2: 36, y2: 4 } as const;

/** 三个节点的半径，左下最大、右上最小。 */
const RADII = [3.8, 2.4, 1.5] as const;

/** 中间节点（呼吸动画的那一颗）。 */
const ACTIVE = 1;

/** 节点位置 = 轴线上按 t 线性插值 —— 因此永远压在线上。 */
const NODES = [0.2, 0.4, 0.58].map((t, i) => ({
  t,
  r: RADII[i],
  x: AXIS.x1 + (AXIS.x2 - AXIS.x1) * t,
  y: AXIS.y1 + (AXIS.y2 - AXIS.y1) * t,
}));

/** 只有图形没有字的版本（favicon / 极窄位置 / 加载态）。 */
export function ProbeMark({
  size = 28,
  nodeColor = "#3b82f6",
  lineColor = "rgba(255,255,255,0.9)",
  label = "探针",
  className,
}: {
  size?: number | string;
  nodeColor?: string;
  lineColor?: string;
  /** 无障碍名称。单独当图形用时给文案；锁标里已有可见文字，传 null 交给读屏跳过。 */
  label?: string | null;
  className?: string;
}) {
  const style = {
    width: typeof size === "number" ? `${size}px` : size,
    height: typeof size === "number" ? `${size}px` : size,
    "--probe-node": nodeColor,
    "--probe-line": lineColor,
  } as CSSProperties;

  return (
    <svg
      viewBox="0 0 40 40"
      role={label ? "img" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={style}
      className={`shrink-0 ${className ?? ""}`}
    >
      <line
        x1={AXIS.x1}
        y1={AXIS.y1}
        x2={AXIS.x2}
        y2={AXIS.y2}
        stroke="var(--probe-line)"
        strokeWidth={1.25}
        strokeLinecap="round"
        /* 发丝线不随锁标缩放变粗：180px 的启动页和 30px 的 Header 是同一根线。 */
        vectorEffect="non-scaling-stroke"
      />
      {NODES.map((n, i) => (
        <circle
          key={n.t}
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill="var(--probe-node)"
          className={i === ACTIVE ? "animate-pulse motion-reduce:animate-none" : undefined}
        />
      ))}
    </svg>
  );
}

export default function ProbeLogo({
  size = 16,
  orientation = "horizontal",
  nodeColor = "#3b82f6",
  lineColor = "rgba(255,255,255,0.9)",
  subtitle = "探针 · 高置信度情报终端",
  className,
}: ProbeLogoProps) {
  const vertical = orientation === "vertical";

  const style = {
    fontSize: typeof size === "number" ? `${size}px` : size,
    "--probe-node": nodeColor,
    "--probe-line": lineColor,
  } as CSSProperties;

  return (
    <span
      style={style}
      className={[
        "inline-flex select-none",
        vertical
          ? "flex-col items-center gap-[0.85em] text-center"
          : "items-center gap-[0.7em]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ProbeMark
        size={vertical ? "2.9em" : "1.85em"}
        nodeColor={nodeColor}
        lineColor={lineColor}
        label={null}
      />

      <span className={`flex min-w-0 flex-col ${vertical ? "items-center" : ""}`}>
        {/* 极细全大写 + 拉开的字距：末字后面会多出一个字距的空隙，
            补一个等量负边距，左右才真正对齐（尤其垂直居中时看得出来）。 */}
        <span className="-mr-[0.42em] whitespace-nowrap text-[1em] font-extralight uppercase leading-none tracking-[0.42em] text-white">
          PROBE
        </span>
        {subtitle ? (
          <span className="mt-[0.56em] hidden whitespace-nowrap text-[0.56em] leading-none tracking-[0.1em] text-neutral-500 sm:block">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
