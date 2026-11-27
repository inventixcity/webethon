export type Box = { x: number; y: number; width: number; height: number };

type Item = { index: number; area: number };

/** How stretched the worst tile in a row would be. Closer to 1 is squarer. */
function worstRatio(row: readonly Item[], side: number) {
  const areas = row.map((item) => item.area);
  const total = areas.reduce((sum, area) => sum + area, 0);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  return Math.max((side * side * largest) / (total * total), (total * total) / (side * side * smallest));
}

/** Packs values into near-square tiles, with the biggest first. Boxes come back in the order of `values`. */
export function squarify(values: readonly number[], box: Box): Box[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  const scale = total > 0 ? (box.width * box.height) / total : 0;
  const items = values.map((value, index) => ({ index, area: Math.max(value, 0) * scale })).sort((a, b) => b.area - a.area);
  const result = values.map(() => ({ x: box.x, y: box.y, width: 0, height: 0 }));
  const room = { ...box };

  function place(row: readonly Item[]) {
    const area = row.reduce((sum, item) => sum + item.area, 0);
    const wide = room.width >= room.height;
    const depth = wide ? area / room.height : area / room.width;
    let along = wide ? room.y : room.x;

    for (const item of row) {
      const length = depth > 0 ? item.area / depth : 0;
      result[item.index] = wide
        ? { x: room.x, y: along, width: depth, height: length }
        : { x: along, y: room.y, width: length, height: depth };
      along += length;
    }

    if (wide) {
      room.x += depth;
      room.width -= depth;
    } else {
      room.y += depth;
      room.height -= depth;
    }
  }

  let row: Item[] = [];
  for (const item of items) {
    const side = Math.min(room.width, room.height);
    const longer = [...row, item];
    if (row.length > 0 && worstRatio(longer, side) > worstRatio(row, side)) {
      place(row);
      row = [item];
    } else {
      row = longer;
    }
  }
  if (row.length > 0) place(row);

  return result;
}
