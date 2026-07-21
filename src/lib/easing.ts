// Cubic smoothstep — the ease-in-out curve shared by every scroll-linked
// fade in the site (Work.astro's plate entry/exit, Hero.astro's top fade).
// t is expected pre-clamped to [0, 1].
export const smoothstep = (t: number): number => t * t * (3 - 2 * t)
