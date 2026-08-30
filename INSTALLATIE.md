# Homebridge Dobiss LAN installeren op Synology

Deze handleiding installeert `homebridge-dobiss-lan` versie `0.5.13` op een
Synology NAS met het officiële Homebridge-pakket voor DSM 7.

## Vooraf

- Maak in Homebridge eerst een back-up via **Backup / Restore**.
- Noteer de huidige pluginconfiguratie.
- Controleer dat de Synology de Dobiss DO5435 kan bereiken op TCP-poort `10001`.
- Gebruik bij voorkeur deze stabiele instellingen:

```json
"pollIntervalSeconds": 30,
"toggleOnStatusReadFailure": true,
"aggressiveStatusRetries": false
```

Download het installatiepakket:

<https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.13/homebridge-dobiss-lan-0.5.13.tgz>

## Methode 1: via de Homebridge UI

1. Open `http://<IP-ADRES-SYNOLOGY>:8581` op het lokale netwerk.
2. Open de Homebridge-terminal via het menu met de drie puntjes rechtsboven.
3. Download het pakket in de terminal:

```bash
curl -L https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.13/homebridge-dobiss-lan-0.5.13.tgz -o /tmp/homebridge-dobiss-lan-0.5.13.tgz
```

4. Installeer het lokale pakket:

```bash
hb-service add /tmp/homebridge-dobiss-lan-0.5.13.tgz
```

5. Open **Plugins** en controleer dat `homebridge-dobiss-lan` versie `0.5.13`
   wordt weergegeven.
6. Voeg onder **Instellingen** de Dobiss-configuratie toe of controleer de
   bestaande configuratie.
7. Herstart Homebridge of alleen de child bridge van de plugin.
8. Controleer de Homebridge-log op `DobissLAN`, verbindingsfouten en ongeldige
   configuratie.

Als `curl` niet beschikbaar is in de UI-terminal, download het bestand op een
computer, kopieer het via DSM File Station naar een gedeelde map en gebruik in
stap 4 het volledige pad naar dat bestand.

## Methode 2: via SSH

Schakel SSH zo nodig tijdelijk in via **DSM > Configuratiescherm > Terminal en
SNMP > SSH-service inschakelen**. Schakel SSH na afloop weer uit als je het niet
blijvend gebruikt.

1. Meld je vanaf een computer aan op de NAS:

```bash
ssh <DSM-GEBRUIKER>@<IP-ADRES-SYNOLOGY>
```

2. Download de release naar een tijdelijk bestand:

```bash
curl -L https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.13/homebridge-dobiss-lan-0.5.13.tgz -o /tmp/homebridge-dobiss-lan-0.5.13.tgz
```

3. Installeer of update de plugin met de Homebridge-servicebeheerder:

```bash
sudo hb-service add /tmp/homebridge-dobiss-lan-0.5.13.tgz
```

4. Herstart Homebridge:

```bash
sudo hb-service restart
```

5. Volg de log tijdens het opstarten:

```bash
sudo hb-service logs
```

Druk op `Ctrl+C` om de live log te verlaten.

## Configuratievoorbeeld

Voeg dit platform toe aan `config.json` of gebruik het instellingenformulier
van de plugin. Pas host, modules en handmatige outputs aan je installatie aan.

```json
{
  "platform": "DobissLAN",
  "name": "Dobiss LAN",
  "host": "192.168.68.164",
  "port": 10001,
  "pollIntervalSeconds": 30,
  "toggleOnStatusReadFailure": true,
  "aggressiveStatusRetries": false,
  "autoDiscover": true,
  "discoveryModules": [1, 2, 3, 4, 5],
  "lights": []
}
```

Auto-discovery presenteert gevonden Dobiss-lichtoutputs standaard als lamp in
HomeKit. Voor een handmatig geconfigureerde gewone output blijft `type` het
Dobiss-protocoltype en bepaalt `homeKitType` de HomeKit-weergave:

```json
{
  "name": "Keuken",
  "type": "switch",
  "homeKitType": "light",
  "module": 3,
  "output": 0
}
```

## Controleren

Controleer na de herstart:

- `homebridge-dobiss-lan` meldt versie `0.5.13` in **Plugins**;
- de log bevat geen herhaalde TCP-time-outs naar de DO5435;
- dimmers kunnen aan, uit en naar een helderheidsniveau worden gestuurd;
- gewone lichtoutputs verschijnen in HomeKit als lamp;
- fysieke drukknoppen worden na maximaal ongeveer 30 seconden bijgewerkt.

## Problemen oplossen

### De installatieopdracht vindt `hb-service` niet

Gebruik op het officiële Synology-pakket een gewone DSM SSH-sessie en voer de
opdracht met `sudo` uit. De officiële installatie gebruikt onder andere:

- configuratie: `/volume1/homebridge/config.json`;
- plugins: `/volume1/homebridge/node_modules`;
- Homebridge-log: `sudo hb-service logs`.

Het volume kan anders zijn wanneer de gedeelde map `homebridge` niet op
`volume1` staat.

### De UI komt niet terug

Controleer eerst:

```bash
sudo hb-service logs
```

Verwijder bij een plugin-gerelateerde startfout alleen deze plugin:

```bash
sudo hb-service remove homebridge-dobiss-lan
sudo hb-service restart
```

Herstel daarna zo nodig de vooraf gemaakte Homebridge-back-up.

### HomeKit toont nog een generieke switch

- Controleer dat versie `0.5.13` actief is.
- Controleer bij handmatige gewone outputs `"type": "switch"` en
  `"homeKitType": "light"`.
- Herstart de hoofd- of child bridge na elke configuratiewijziging.

## Officiële Homebridge-referenties

- <https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Synology-DSM>
- <https://github.com/homebridge/homebridge-syno-spk>

