/** Conservative current-document publication evidence, excluding references. */
export function currentAuthorityEvidence(text:string):string[] {
 const prefix=text.slice(0,4000).split(/(?:规范性引用文件|参考文献|引用标准|参考标准|normative references|bibliography)/i)[0]!;
 if(/草案|征求意见|尚未.{0,8}(?:发布|批准)|未经.{0,8}批准|未正式发布|draft|not\s+(?:yet\s+)?approved/i.test(prefix))return [];
 return prefix.split(/\r?\n/).map(line=>line.trim()).filter(line=>line.length>0&&line.length<600&&
  /正式发布|正式版本|已批准|批准发布|发布机构\s*[:：]\s*\S|approved\s+release|official\s+(?:manual|specification|release)/i.test(line)&&
  !/引用|参见|参考|根据|应当|应经|须经|待批准|未批准|not\s+|reference/i.test(line));
}
export function hasCurrentAuthorityEvidence(text:string,evidence?:string):boolean {
 const lines=currentAuthorityEvidence(text);
 return evidence===undefined?lines.length>0:Boolean(evidence.trim()&&text.includes(evidence.trim())&&lines.some(line=>line.includes(evidence.trim())||evidence.includes(line)));
}
