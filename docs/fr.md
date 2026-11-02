# Litière UBPet

Pilotez les litières autonettoyantes UBPet / UPET (UBPet C20, C10, C10 Pro et les autres litières de l'application UPET, y compris les versions Meowant et Airrobo) depuis Gladys Assistant.

L'intégration utilise le même cloud que l'application officielle UPET. L'état de la litière et les nouvelles visites arrivent en temps réel par la connexion directe du fabricant ; le bac à déchets, le désodorisant et l'historique sont relus toutes les quelques minutes.

## Ce que vous obtenez

Un appareil Gladys par litière, avec :

| Fonction                  | Rôle                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Cleaning (nettoyage)      | Interrupteur : allumé lance (ou reprend) un nettoyage, éteint le met en pause.             |
| Levelling (nivellement)   | Interrupteur : idem pour niveler la litière.                                               |
| Command (commande)        | Nettoyer, Niveler, Pause, Reprendre, Bac vidé, Rafraîchir l'état.                          |
| Status (état)             | Idle (au repos), Cleaning, Levelling, paused, blocked, Offline...                          |
| Cat inside (chat présent) | En direct : 1 tant qu'un chat est dans la litière.                                         |
| Waste bin level           | Remplissage du bac à déchets en %.                                                         |
| Uses since bin emptied    | Utilisations depuis le dernier vidage, remis à zéro par la commande « Waste bin emptied ». |
| Visits in the last 24 h   | Visites des dernières 24 h.                                                                |
| Last visit, duration      | Par ex. « Milo · 4.3 kg · 52 s ».                                                          |
| Deodorant remaining       | Jours restants du désodorisant.                                                            |
| Auto clean after use      | Nettoyage automatique après usage, et son délai en minutes (1 à 60).                       |

Les noms des fonctions et les textes d'état sont en anglais, comme dans l'application.

Déclencheurs de scène : **Un chat a utilisé la litière** (filtre par litière et nom du chat ; transmet le chat, le poids et la durée), **Le bac à déchets est plein**, **La litière est bloquée**.

**Sécurité :** l'intégration refuse de lancer ou de reprendre un mouvement si la litière signale un chat dedans ou à proximité, ou si son état est inconnu. Les protections propres de la litière (poids, infrarouge) restent actives en plus.

## Prérequis

- Gladys Assistant 5.1 ou plus récent.
- La litière installée dans l'application **UPET**, connectée à Internet.
- **Un second compte UPET (fortement recommandé).** Le cloud UPET n'autorise qu'une session par compte : si Gladys et votre téléphone utilisent le même compte, ils se déconnectent mutuellement. Créez un second compte dans l'application UPET, puis partagez-lui la litière depuis votre compte principal (réglages de l'appareil, partage). Utilisez ce second compte dans Gladys.

## Configuration

1. **Édition de l'application / région** : l'édition de l'application UPET où le compte a été créé. En Europe (Suisse et France comprises), c'est **UPET - Europe**. Les comptes nord-américains utilisent UPET-NA, les comptes japonais et coréens UPET-ASIA. Une mauvaise région donne « Unknown account on this server ».
2. **Code pays** : le pays choisi dans l'application, en deux lettres (FR, CH, BE...). Facultatif pour la plupart des comptes, nécessaire pour certains (comptes russes notamment).
3. **Compte UPET** et **mot de passe** du second compte.
4. Enregistrez, puis cliquez sur **Tester la connexion** : le résultat liste les litières trouvées et indique si le lien temps réel est actif.
5. Ouvrez l'onglet **Découverte** et créez la litière.

Laissez vides les champs **Avancé** : ils ne servent que si le fabricant change l'identité de l'application.

## Dépannage

- **« Wrong account or password »** : vérifiez les identifiants dans l'application UPET. L'intégration ne réessaie pas d'elle-même un mot de passe refusé (les refus répétés peuvent bloquer le compte) ; enregistrer la configuration relance la connexion.
- **« Unknown account on this server »** : mauvaise région, voir l'étape 1.
- **« Une autre connexion sur ce compte UPET a pris la session »** : Gladys et le téléphone partagent un compte. Utilisez un second compte.
- **État « Unknown » et commandes refusées (« Box state unknown »)** : le lien temps réel est coupé (point orange sur le badge cloud de l'appareil). Il se reconnecte seul, en espaçant les essais jusqu'à 30 minutes si une autre connexion reprend la session.
- **« The box is busy »** : impossible de lancer un nettoyage pendant un nivellement, par exemple. Mettez en pause ou attendez la fin.

Intégration communautaire, sans lien avec UBTECH / UPET. Elle repose sur l'API privée du fabricant, rétro-conçue par la communauté Home Assistant, qui peut changer sans préavis.
