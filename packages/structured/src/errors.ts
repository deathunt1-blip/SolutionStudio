/** Expected domain failures are safe to show; storage and infrastructure errors must remain private. */
export class StructuredError extends Error {
 constructor(public readonly code:'invalid_input'|'not_found',message:string){super(message);this.name='StructuredError';}
}
