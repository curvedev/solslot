import {bootPlayground} from './playground-runtime.js';
import {createMainnetPlayground,connectMainnetWallet} from './mainnet-playground.js';
import {mainnetConnection} from './mainnet-spin.js';
bootPlayground({mainnet:true,makeGame:createMainnetPlayground,connectWalletAdapter:connectMainnetWallet,connection:mainnetConnection(),configUrl:'./mainnet-config.json'});
