// Integral images make local illumination/texture estimates linear in image size.
export function localImageStats(
  pixels: Uint8Array,
  width: number,
  height: number,
  radius: number,
  variance = false,
) {
  const stride = width + 1,
    sum = new Float64Array(stride * (height + 1));
  const squares = variance ? new Float64Array(sum.length) : null;
  for (let y = 0; y < height; y++) {
    let row = 0,
      squared = 0;
    for (let x = 0; x < width; x++) {
      const value = pixels[y * width + x];
      row += value;
      squared += value * value;
      const index = (y + 1) * stride + x + 1;
      sum[index] = sum[index - stride] + row;
      if (squares) squares[index] = squares[index - stride] + squared;
    }
  }
  const mean = new Float32Array(pixels.length),
    deviation = variance ? new Float32Array(pixels.length) : null;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius),
        right = Math.min(width, x + radius + 1);
      const top = Math.max(0, y - radius),
        bottom = Math.min(height, y + radius + 1);
      const a = bottom * stride + right,
        b = top * stride + right,
        c = bottom * stride + left,
        d = top * stride + left;
      const count = (right - left) * (bottom - top),
        index = y * width + x;
      const average = (sum[a] - sum[b] - sum[c] + sum[d]) / count;
      mean[index] = average;
      if (squares && deviation)
        deviation[index] = Math.sqrt(
          Math.max(
            0,
            (squares[a] - squares[b] - squares[c] + squares[d]) / count - average * average,
          ),
        );
    }
  return { mean, deviation };
}
