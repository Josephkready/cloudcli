// UNUSED — not part of the build, and nothing in the app references its output.
//
// This emits SVGs of a design the app does not ship: a purple rounded square
// with a MessageSquare glyph, from an icon rework that was never finished. The
// PNGs actually served are a different, dark full-bleed mark. Converting these
// SVGs to PNG would REPLACE the app icon with that other design, which is a
// visual change for a human to decide, not a build step to run.
//
// The shipped icons are three real sizes resampled from icon-512x512.png. See
// public/convert-icons.md for what ships and how to regenerate it (issue #369).
const fs = require('fs');
const path = require('path');

// Sizes for the unshipped SVG set only — NOT the sizes the manifest declares.
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

// SVG template function
function createIconSVG(size) {
  const cornerRadius = Math.round(size * 0.25); // 25% corner radius
  const strokeWidth = Math.max(2, Math.round(size * 0.06)); // Scale stroke width
  
  // MessageSquare path scaled to size
  const padding = Math.round(size * 0.25);
  const iconSize = size - (padding * 2);
  const startX = padding;
  const startY = Math.round(padding * 0.7);
  const endX = startX + iconSize;
  const endY = startY + Math.round(iconSize * 0.6);
  const tailX = startX;
  const tailY = endY + Math.round(iconSize * 0.3);
  
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Background with rounded corners -->
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="hsl(262.1 83.3% 57.8%)"/>
  
  <!-- MessageSquare icon -->
  <path d="M${startX} ${startY}C${startX} ${startY - 10} ${startX + 10} ${startY - 20} ${startX + 20} ${startY - 20}H${endX - 20}C${endX - 10} ${startY - 20} ${endX} ${startY - 10} ${endX} ${startY}V${endY - 20}C${endX} ${endY - 10} ${endX - 10} ${endY} ${endX - 20} ${endY}H${startX + Math.round(iconSize * 0.4)}L${tailX} ${tailY}V${startY}Z" 
        stroke="white" 
        stroke-width="${strokeWidth}" 
        stroke-linecap="round" 
        stroke-linejoin="round" 
        fill="none"/>
</svg>`;
}

// Generate SVG files for each size
sizes.forEach(size => {
  const svgContent = createIconSVG(size);
  const filename = `icon-${size}x${size}.svg`;
  const filepath = path.join(__dirname, 'icons', filename);
  
  fs.writeFileSync(filepath, svgContent);
  console.log(`Created ${filename}`);
});

console.log('\nSVG icons created! To convert to PNG, you can use:');
console.log('1. Online converter like cloudconvert.com');
console.log('2. If you have ImageMagick: convert icon.svg icon.png');
console.log('3. If you have Inkscape: inkscape --export-type=png icon.svg');