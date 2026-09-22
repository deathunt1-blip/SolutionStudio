/** Filename fallback preserves identifiers/dates; it never promotes a chapter heading. */
export function filenameTitle(filename:string):string {
 const stem=filename.replace(/\.[^.\\/]{1,10}$/u,'').replace(/(?:\s*[(（]\d+[)）])+$/u,'').replace(/(?:\s*[-_]?副本)+$/u,'').trim();
 return (stem||filename||'未命名资料').slice(0,500);
}
