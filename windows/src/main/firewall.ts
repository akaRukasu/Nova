// Pare-feu de Windows : sur un réseau « public » (partage de connexion du téléphone, Wi-Fi d'hôtel…), Windows bloque
// les connexions entrantes vers Nova ; l'iPhone ne peut alors ni envoyer sa bibliothèque ni piloter la lecture.
import { execFile } from 'node:child_process';

const RULE = 'Nova (iPhone et Jam)';

function powershell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Windows uniquement'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
  });
}

/** Réseaux actuels classés « publics » par Windows, et la règle de Nova est-elle déjà en place ? */
export async function networkStatus(): Promise<{ publicNetworks: string[]; allowed: boolean }> {
  const [names, rule] = await Promise.all([
    powershell("Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | Select-Object -ExpandProperty Name").catch(() => ''),
    powershell(`(Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Measure-Object).Count`).catch(() => '0'),
  ]);
  return { publicNetworks: names.split(/\r?\n/).map((n) => n.trim()).filter(Boolean), allowed: Number(rule) > 0 };
}

/** Autorise Nova sur tous les réseaux (une fois ; Windows demande la confirmation de l'administrateur). */
export async function allowEverywhere(): Promise<boolean> {
  const script = [
    `Remove-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue`,
    // Synchronisation et télécommande de l'iPhone (47822), Jam (47821), découverte Bonjour (5353).
    `New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47821,47822 -Profile Any`,
    `New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47821,5353 -Profile Any`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    await powershell(`Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`);
  } catch {
    return false;
  }
  return (await networkStatus()).allowed;
}
