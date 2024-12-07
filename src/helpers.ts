// Helper functions

export function getVendorModelFromModelString(modelString: string): { vendor: string, model: string } {
    // split the model name at the first space and return the vendor part
    const vendor = modelString.match(/^\[(.*?)\]/)?.[1] ?? ''; // extract vendor or fallback to empty string
    const model = modelString.replace(/^\[.*?\]\s*/, ''); // remove vendor part
    return { vendor, model };
}