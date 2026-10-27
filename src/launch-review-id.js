// Public fingerprint only: never include signed approvals or private runtime files.
import {createHash} from 'node:crypto';
export function launchReviewId(config){
 const reviewed={owner:config.owner,mint:config.mint,program:config.gameProgram,binary:config.release.binarySha256,creatorFeeSweeps:config.pumpfun.creatorFeeSweeps===true,programPins:config.prelaunch.programPins,approvalMessages:config.prelaunch.approvalMessageSha256,...(config.oraoProbe?.enabled===true?{oraoProbe:{enabled:true,maximumCount:3,maximumDebitLamports:5000000}}:{})};
 return createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
}
