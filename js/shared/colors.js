// Player colours: sticky-note shades that read well both as paper tint in 3D
// and as UI chips. Index by seat.
export const PLAYER_COLORS = ['#f2c94c', '#ef8fa8', '#7fb7e0', '#8fcf8b', '#c9a0dc', '#f4a259', '#9ad1d4', '#e0e0a0'];
export const colorFor = seat => PLAYER_COLORS[seat % PLAYER_COLORS.length];

export const TIER_COLORS = ['#e9dcbc', '#a9cfae', '#9dbfe2', '#eeb27a', '#e2725b'];
