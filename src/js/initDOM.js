import { homeTemplate } from './components/homeTemplate.js';
import { guildTemplate } from './components/guildTemplate.js';
import { lobbyTemplate } from './components/lobbyTemplate.js';
import { gameUITemplate } from './components/gameUITemplate.js';
import { modalsTemplate } from './components/modalsTemplate.js';

const appContainer = document.getElementById('app');
if (appContainer) {
  appContainer.innerHTML = 
        homeTemplate() + 
        guildTemplate() + 
        lobbyTemplate() + 
        gameUITemplate() + 
        modalsTemplate();
} else {
  console.error('Could not find #app container');
}
