import { fero } from 'fero'

// three cats to start: a seed makes a server
const cafe = await fero('cafe', { data: {
    luna: { mood: 'sleepy' },
    mochi: { mood: 'playful' },
    biscuit: { mood: 'hungry' },
} })

// tap runs now and on each change
cafe.data.tap(() => console.log(cafe.snapshot))
