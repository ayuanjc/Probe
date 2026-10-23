/**
 * 浮层落点：把一块 fixed 定位的面板放到锚点旁边，并夹进视口。
 *
 * 术语解释（Glossary）与 DIY 面板（ModuleDock）原先各写了一遍同样的算术：
 * 先按 align 猜一侧 → 越界就夹 → 下方放不下就上翻。猜错的表现是浮层被切在屏幕外，
 * 所以位置一律实测、不靠 CSS 的 left-0 / right-0 去猜。收敛成一份，改一处两处都对。
 *
 * 这里只算坐标，不管渲染：面板尺寸由调用方渲染后量出来再传进来。
 */

export type FloatingPlacement = {
  left: number;
  top: number;
  /** 夹进视口后的实际宽度（可能小于 maxWidth）。 */
  width: number;
};

export type FloatingAnchor = { left: number; top: number; right: number; bottom: number };

export type PlaceInput = {
  /** 锚点矩形（触发词、按钮）。DOMRect 结构兼容。 */
  anchor: FloatingAnchor;
  /** 面板实测尺寸（offsetWidth / offsetHeight）。 */
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  /** 横向优先贴哪一侧；最终位置仍会被夹回视口，所以这只是偏好。 */
  align?: "left" | "right";
  /** 面板宽度上限。 */
  maxWidth?: number;
  /** 面板与锚点之间的间距。 */
  gap?: number;
  /** 与视口边缘的最小留白。 */
  edge?: number;
};

const DEFAULT_EDGE = 8;

export function placeFloating({
  anchor,
  panel,
  viewport,
  align = "left",
  maxWidth = 340,
  gap = 8,
  edge = DEFAULT_EDGE,
}: PlaceInput): FloatingPlacement {
  const width = Math.min(maxWidth, Math.max(0, viewport.width - edge * 2));

  const preferred = align === "right" ? anchor.right - width : anchor.left;
  const left = Math.min(Math.max(edge, preferred), Math.max(edge, viewport.width - edge - width));

  let top = anchor.bottom + gap;
  if (top + panel.height > viewport.height - edge) {
    const above = anchor.top - gap - panel.height;
    // 上方也放不下时贴底：宁可压住锚点，也不要跑出视口。
    top = above >= edge ? above : Math.max(edge, viewport.height - edge - panel.height);
  }

  return { left, top, width };
}

/** 锚点是否还看得见：滚出视口的锚点不该留一个悬空浮层。 */
export function anchorVisible(
  anchor: Pick<FloatingAnchor, "top" | "bottom">,
  viewportHeight: number,
  slack = 4,
): boolean {
  return !(anchor.bottom < -slack || anchor.top > viewportHeight + slack);
}
