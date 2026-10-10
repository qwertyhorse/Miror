export interface MaterialRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MaterialDropTarget {
  /** Boundary in the unchanged list, before the dragged item is removed. */
  slot: number;
  left: number;
  top: number;
  height: number;
}

interface Row { cards: { rect: MaterialRect; index: number }[]; top: number; bottom: number }

/** Find an insertion boundary from layout alone, including gaps and row wraps. */
export function materialDropTarget(rects: MaterialRect[], x: number, y: number): MaterialDropTarget | null {
  if (!rects.length) return null;
  const rows: Row[] = [];
  rects.forEach((rect, index) => {
    let row = rows.at(-1);
    // CSS grid cards share a top edge. The tolerance also permits subpixel layout.
    if (!row || Math.abs(rect.top - row.top) > 2) {
      row = { cards: [], top: rect.top, bottom: rect.bottom }; rows.push(row);
    }
    row.cards.push({ rect, index }); row.bottom = Math.max(row.bottom, rect.bottom);
  });
  const firstRow = rows[0], lastRow = rows[rows.length - 1];
  const edge = (row: Row, atEnd: boolean): MaterialDropTarget => {
    const card = atEnd ? row.cards[row.cards.length - 1] : row.cards[0];
    return { slot: card.index + (atEnd ? 1 : 0), left: atEnd ? card.rect.right : card.rect.left, top: row.top, height: row.bottom - row.top };
  };
  if (y < firstRow.top) return edge(firstRow, false);
  if (y > lastRow.bottom) return edge(lastRow, true);
  let row = firstRow, nearest = Infinity;
  for (const candidate of rows) {
    const distance = y < candidate.top ? candidate.top - y : y > candidate.bottom ? y - candidate.bottom : 0;
    if (distance < nearest) { row = candidate; nearest = distance; }
  }
  const candidates = [edge(row, false)];
  for (let index = 1; index < row.cards.length; index++) {
    candidates.push({ slot: row.cards[index].index, left: (row.cards[index - 1].rect.right + row.cards[index].rect.left) / 2,
      top: row.top, height: row.bottom - row.top });
  }
  candidates.push(edge(row, true));
  return candidates.reduce((best, candidate) => Math.abs(candidate.left - x) < Math.abs(best.left - x) ? candidate : best);
}

/** Convert an unchanged-list boundary into a final insertion index. */
export function insertMaterialAtSlot(ids: string[], id: string, slot: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || !Number.isInteger(slot) || slot < 0 || slot > ids.length) return ids;
  const to = slot > from ? slot - 1 : slot;
  if (from === to) return ids;
  const next = [...ids]; next.splice(from, 1); next.splice(to, 0, id); return next;
}
