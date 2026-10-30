// Pure visibility rules for the HUD and the results claim. `hudHidden` is set by other plugins
// (RockHeroSmith) through window.feedBackScorecard.setHudHidden().

// playing: a drums / 5-fret player is followed (RockHeroSmith play:* input). That HUD shows on
// any arrangement and whatever hudHidden says (hudHidden is about the Note Detection HUD); the
// guitar HUD stays off on drum arrangements (pitch judgments mean nothing on a drum chart).
export function wantsHud({ onPlayer, mode, isDrums, playing, hasRun, frozen, ndEnabled, hudHidden }) {
    if (!onPlayer || mode === 'off') return false;
    if (playing) return true;
    return !!(!isDrums && (hasRun || frozen || ndEnabled) && !hudHidden);
}

// playSession: a RockHeroSmith play:* session is live; its results screen owns the end of the song.
export function claimsResults({ judged, minJudged, mode, hudHidden, playSession }) {
    return judged >= minJudged && mode !== 'off' && !hudHidden && !playSession;
}
