/** Timestamped stderr logging (launchd redirects it to ~/Library/Logs/cloudtidy). Never pass document text here. */
export const log = (msg: string) => { if (!process.env.CLOUDTIDY_QUIET) console.error(`${new Date().toISOString()} ${msg}`); };
