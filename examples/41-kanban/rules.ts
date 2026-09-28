// the one rule, carried by the board and by every editor: status names a column, and a card is written by its fields
const COLS = ['todo', 'doing', 'done']
export const rules = (r) => r.key[1] === 'status' && !COLS.includes(r.value) ? 'unknown column'
    : r.value === undefined ? true
    : r.key.length < 2 ? 'this board writes fields, never whole rows' : true
