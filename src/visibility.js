// Pure visibility rules for the HUD and the results claim. `hudHidden` is set by other plugins
// (Build-a-Band) through window.feedBackScorecard.setHudHidden().

export function wantsHud({ onPlayer, mode, isDrums, hasRun, frozen, ndEnabled, hudHidden }) {
    return !!(onPlayer && mode !== 'off' && !isDrums && (hasRun || frozen || ndEnabled) && !hudHidden);
}

export function claimsResults({ judged, minJudged, mode, hudHidden }) {
    return judged >= minJudged && mode !== 'off' && !hudHidden;
}
