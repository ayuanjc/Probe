"use client";

import ReactEChartsCore from "echarts-for-react/lib/core";
import type { EChartsReactProps } from "echarts-for-react/lib/types";
import * as echarts from "echarts/core";
import {
  BarChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  DatasetComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

/**
 * 按需注册的 ECharts。
 *
 * 原来的写法是 `import "echarts-for-react"`，它把整包 echarts（含地理地图、3D、
 * 桑基图、K 线、箱线图等本项目一个都没用的模块）一起打进一个 1.1MB 的块。
 * 面板里真正出现的图形只有这几种（见 src/lib/compile.ts 的 series.type）：
 * pie / treemap / scatter / heatmap / radar / graph / funnel / gauge，
 * 再加 line / bar 备用。压缩后这一个块能瘦掉一半，慢网下首张图快半秒以上。
 *
 * 注册必须发生一次且在渲染之前：模块级 echarts.use() 只跑一次，多个 ChartBox
 * 共用同一份实例。少注册一个图形不会报错，只会画出一片空白 —— 加新图形时
 * 一定同步这里。
 */
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  TreemapChart,
  ScatterChart,
  HeatmapChart,
  RadarChart,
  GraphChart,
  FunnelChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
  TransformComponent,
  VisualMapComponent,
  MarkLineComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export default function EChart(props: EChartsReactProps) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
