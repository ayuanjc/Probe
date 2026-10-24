"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";

const Chart = dynamic(() => import("echarts-for-react"), {
  ssr: false,
  loading: () => <div className="skeleton h-full min-h-[160px] w-full rounded-md" />,
});

type ChartLike = { resize: () => void };

/**
 * 图表容器：ECharts 只知道 window 尺寸，不知道「卡片被拖大了」。
 * 原来把卡片从 4×8 拖到 6×11，canvas 还是旧尺寸，图被拉花。
 * 这里用 ResizeObserver 盯容器，按帧去抖后再 resize（拖拽途中不重算，
 * 松手才真正重绘一次）。
 *
 * 抽成公共组件是因为实体关系图也要同一套逻辑：它会随「选中哪个实体」
 * 换一份 option，但容器尺寸变化的原因仍然是拖拽与窗口缩放。
 */
export default function ChartBox({
  option,
  onEvents,
  minHeight = 180,
  className,
}: {
  option: Record<string, unknown>;
  onEvents?: Record<string, (params: never) => void>;
  minHeight?: number;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<ChartLike | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let raf = 0;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        instRef.current?.resize();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={boxRef} className={"flex-1 " + (className ?? "")} style={{ minHeight }}>
      <Chart
        option={option}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate
        opts={{ renderer: "canvas" }}
        onEvents={onEvents}
        onChartReady={(inst: ChartLike) => {
          instRef.current = inst;
        }}
      />
    </div>
  );
}