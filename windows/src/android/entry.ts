// Point d'entrée de Nova pour Android : le pont natif d'abord, puis la même interface que sur Windows.
import { prepare } from './bridge';

void prepare().finally(() => import('../renderer/main'));
