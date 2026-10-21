// cats.js — the café's one cat drawing, shared by every section, so a cat looks the same everywhere on the page.
// Decoration only: a face goes beside the mood word, never in its place (aria-hidden).
//   import { catSvg } from '../cats.js';  el.innerHTML = catSvg('purring')

const HEAD = 'M7.5 31.5C3.2 27.5 2.8 19.6 5.6 14L4.6 3.2l8.6 5.1c4.2-1.4 9.4-1.4 13.6 0l8.6-5.1-1 10.8c2.8 5.6 2.4 13.5-1.9 17.5-6.1 3.1-18.9 3.1-25 0z'
const WHISK = 'M.6 21.4l6.6 1.2M1 26l6.4-1.2M39.4 21.4l-6.6 1.2M39 26l-6.4-1.2'
const W_MOUTH = 'M16.8 24.2q1.6 2.3 3.2 0q1.6 2.3 3.2 0'

// one face per mood the café uses (core.js HOUSE: the seed moods and the scripted visitor's cycle)
export const FACES = {
  sleepy: `<path d="M10.8 18.6q3.2 2.6 6.4 0M22.8 18.6q3.2 2.6 6.4 0"/><path d="M18.6 25.2q1.4 1 2.8 0"/>`,
  playful: `<circle class="fill" cx="14" cy="18.6" r="1.9"/><path d="M22.8 19.2q3.2-2.6 6.4 0"/><path d="${W_MOUTH}"/>`,
  hungry: `<circle class="fill" cx="14" cy="18.6" r="2"/><circle class="fill" cx="26" cy="18.6" r="2"/><ellipse cx="20" cy="25.4" rx="1.9" ry="2.3"/>`,
  purring: `<path d="M10.8 19.8l3.2-3 3.2 3M22.8 19.8l3.2-3 3.2 3"/><path d="${W_MOUTH}"/>`,
  zoomies: `<circle cx="14" cy="18.4" r="2.9"/><circle cx="26" cy="18.4" r="2.9"/><circle class="fill" cx="14.6" cy="18.4" r="1.1"/><circle class="fill" cx="26.6" cy="18.4" r="1.1"/><path d="M17 24.2q3 4.4 6 0z"/><path d="M-7 11h4M-9 17h5M-7 23h4"/>`,
  grumpy: `<path d="M10.4 15.4l6.2 2M29.6 15.4l-6.2 2"/><path d="M11.4 19.8h5.2M23.4 19.8h5.2"/><path d="M16.8 26.6q3.2-2.8 6.4 0"/>`,
}
// any other mood (a console write): a plain, content face
const NEUTRAL = `<circle class="fill" cx="14" cy="18.6" r="1.9"/><circle class="fill" cx="26" cy="18.6" r="1.9"/><path d="${W_MOUTH}"/>`

export const catSvg = (mood) => `<svg viewBox="0 0 40 34" aria-hidden="true" focusable="false"><path d="${HEAD}"/><path d="${WHISK}"/>${FACES[mood] ?? NEUTRAL}</svg>`
