// A prelaunch release may operate its fixed setup worker while entries remain
// conditional on verified on-chain activation and current worker admission.
export function executableMainnetRelease(config){
 return config?.release?.status==='verified'||(config.prelaunch?.enabled===true&&(
  config.release?.status==='prelaunch-armed'||
  (config.release?.status==='prelaunch-staged'&&config.prelaunch.requireHealthySetup===true)
 ));
}
