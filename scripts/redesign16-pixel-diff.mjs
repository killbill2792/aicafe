// Permit only near-invisible browser rasterization noise; fail all real UI changes.
export function negligibleScreenshotDrift({ sameDimensions, changedPixels, maxChannelDelta }) {
  return sameDimensions === true &&
    Number.isInteger(changedPixels) && changedPixels >= 0 && changedPixels <= 20 &&
    Number.isInteger(maxChannelDelta) && maxChannelDelta >= 0 && maxChannelDelta <= 1;
}
