import { gardenIconUri, gardenSceneUri, type GardenIconKey, type GardenScene } from "../domain/garden-visuals";

export function GardenIcon({ kind, className = "" }: { kind: GardenIconKey; className?: string }) {
  return <span className={`garden-icon ${className}`} aria-hidden="true"><img src={gardenIconUri(kind)} alt="" width={48} height={48} /></span>;
}

export function GardenIllustration({ scene, className = "" }: { scene: GardenScene; className?: string }) {
  return <img className={`garden-illustration ${className}`} src={gardenSceneUri(scene)} alt="" aria-hidden="true" width={480} height={180} />;
}
