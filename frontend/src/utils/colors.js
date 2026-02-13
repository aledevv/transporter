/**
 * Generates a color map for a list of strings using Golden Angle approximation.
 * This ensures distinct colors for each unique string.
 * @param {Array<string>} strings - List of strings (e.g. all institute names)
 * @returns {Object} - Map { "string": "hsl(...)" }
 */
export const getColorForIndex = (index) => {
    // Golden Angle = 137.508 degrees
    // We start from a base hue (e.g. 200 for blue-ish) and add golden angle * index
    // This guarantees maximum separation on the color wheel for sequential items
    const hue = (200 + index * 137.508) % 360;
    return `hsl(${hue}, 70%, 45%)`;
};

/**
 * Generates a color map for a list of strings using Golden Angle approximation.
 * This ensures distinct colors for each unique string.
 * @param {Array<string>} strings - List of strings (e.g. all institute names)
 * @returns {Object} - Map { "string": "hsl(...)" }
 */
export const getInstituteColorMap = (allInstitutes) => {
    const uniqueInstitutes = [...new Set(allInstitutes.filter(Boolean))].sort();
    const map = {};

    uniqueInstitutes.forEach((name, index) => {
        map[name] = getColorForIndex(index);
    });

    return map;
};

// Keep a backward compatible Helper for single usage? 
// No, the requirement effectively deprecates stateless hashing if we want "distinct from others".
// But we can keep a fallback that tries to simulate it or just use the map.

