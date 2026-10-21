import { fero } from 'fero'

// no seed: a client finds the café by name
const cafe = await fero('cafe')

// watch the cats too; snapshot is a plain copy to print
cafe.data.tap(() => console.log(cafe.snapshot))

// biscuit gets a snack
cafe.data.biscuit = { mood: 'purring' }
