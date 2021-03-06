/**
 * @module ol/interaction/Snap
 */
import {getUid} from '../util.js';
import {CollectionEvent} from '../Collection.js';
import CollectionEventType from '../CollectionEventType.js';
import {distance as coordinateDistance, squaredDistance as squaredCoordinateDistance, closestOnCircle, closestOnSegment, squaredDistanceToSegment} from '../coordinate.js';
import {listen, unlistenByKey} from '../events.js';
import EventType from '../events/EventType.js';
import {boundingExtent, createEmpty} from '../extent.js';
import {TRUE, FALSE} from '../functions.js';
import GeometryType from '../geom/GeometryType.js';
import {fromCircle} from '../geom/Polygon.js';
import PointerInteraction, {handleEvent as handlePointerEvent} from '../interaction/Pointer.js';
import {getValues} from '../obj.js';
import {VectorSourceEvent} from '../source/Vector.js';
import VectorEventType from '../source/VectorEventType.js';
import RBush from '../structs/RBush.js';


/**
 * @typedef {Object} Result
 * @property {boolean} snapped
 * @property {import("../coordinate.js").Coordinate|null} vertex
 * @property {import("../pixel.js").Pixel|null} vertexPixel
 */


/**
 * @typedef {Object} SegmentData
 * @property {import("../Feature.js").default} feature
 * @property {Array<import("../coordinate.js").Coordinate>} segment
 */


/**
 * @typedef {Object} Options
 * @property {import("../Collection.js").default<import("../Feature.js").default>} [features] Snap to these features. Either this option or source should be provided.
 * @property {boolean} [edge=true] Snap to edges.
 * @property {boolean} [vertex=true] Snap to vertices.
 * @property {number} [pixelTolerance=10] Pixel tolerance for considering the pointer close enough to a segment or
 * vertex for snapping.
 * @property {import("../source/Vector.js").default} [source] Snap to features from this source. Either this option or features should be provided
 */


/**
 * @classdesc
 * Handles snapping of vector features while modifying or drawing them.  The
 * features can come from a {@link module:ol/source/Vector} or {@link module:ol/Collection~Collection}
 * Any interaction object that allows the user to interact
 * with the features using the mouse can benefit from the snapping, as long
 * as it is added before.
 *
 * The snap interaction modifies map browser event `coordinate` and `pixel`
 * properties to force the snap to occur to any interaction that them.
 *
 * Example:
 *
 *     import Snap from 'ol/interaction/Snap';
 *
 *     var snap = new Snap({
 *       source: source
 *     });
 *
 * @api
 */
class Snap extends PointerInteraction {
  /**
   * @param {Options=} opt_options Options.
   */
  constructor(opt_options) {

    super({
      handleEvent: handleEvent,
      handleDownEvent: TRUE,
      handleUpEvent: handleUpEvent,
      stopDown: FALSE
    });

    const options = opt_options ? opt_options : {};

    /**
     * @type {import("../source/Vector.js").default}
     * @private
     */
    this.source_ = options.source ? options.source : null;

    /**
     * @private
     * @type {boolean}
     */
    this.vertex_ = options.vertex !== undefined ? options.vertex : true;

    /**
     * @private
     * @type {boolean}
     */
    this.edge_ = options.edge !== undefined ? options.edge : true;

    /**
     * @type {import("../Collection.js").default<import("../Feature.js").default>}
     * @private
     */
    this.features_ = options.features ? options.features : null;

    /**
     * @type {Array<import("../events.js").EventsKey>}
     * @private
     */
    this.featuresListenerKeys_ = [];

    /**
     * @type {Object<number, import("../events.js").EventsKey>}
     * @private
     */
    this.featureChangeListenerKeys_ = {};

    /**
     * Extents are preserved so indexed segment can be quickly removed
     * when its feature geometry changes
     * @type {Object<number, import("../extent.js").Extent>}
     * @private
     */
    this.indexedFeaturesExtents_ = {};

    /**
     * If a feature geometry changes while a pointer drag|move event occurs, the
     * feature doesn't get updated right away.  It will be at the next 'pointerup'
     * event fired.
     * @type {!Object<number, import("../Feature.js").default>}
     * @private
     */
    this.pendingFeatures_ = {};

    /**
     * Used for distance sorting in sortByDistance_
     * @type {import("../coordinate.js").Coordinate}
     * @private
     */
    this.pixelCoordinate_ = null;

    /**
     * @type {number}
     * @private
     */
    this.pixelTolerance_ = options.pixelTolerance !== undefined ?
      options.pixelTolerance : 10;

    /**
     * @type {function(SegmentData, SegmentData): number}
     * @private
     */
    this.sortByDistance_ = sortByDistance.bind(this);


    /**
    * Segment RTree for each layer
    * @type {import("../structs/RBush.js").default<SegmentData>}
    * @private
    */
    this.rBush_ = new RBush();


    /**
    * @const
    * @private
    * @type {Object<string, function(import("../Feature.js").default, import("../geom/Geometry.js").default)>}
    */
    this.SEGMENT_WRITERS_ = {
      'Point': this.writePointGeometry_,
      'LineString': this.writeLineStringGeometry_,
      'LinearRing': this.writeLineStringGeometry_,
      'Polygon': this.writePolygonGeometry_,
      'MultiPoint': this.writeMultiPointGeometry_,
      'MultiLineString': this.writeMultiLineStringGeometry_,
      'MultiPolygon': this.writeMultiPolygonGeometry_,
      'GeometryCollection': this.writeGeometryCollectionGeometry_,
      'Circle': this.writeCircleGeometry_
    };
  }

  /**
   * Add a feature to the collection of features that we may snap to.
   * @param {import("../Feature.js").default} feature Feature.
   * @param {boolean=} opt_listen Whether to listen to the feature change or not
   *     Defaults to `true`.
   * @api
   */
  addFeature(feature, opt_listen) {
    const register = opt_listen !== undefined ? opt_listen : true;
    const feature_uid = getUid(feature);
    const geometry = feature.getGeometry();
    if (geometry) {
      const segmentWriter = this.SEGMENT_WRITERS_[geometry.getType()];
      if (segmentWriter) {
        this.indexedFeaturesExtents_[feature_uid] = geometry.getExtent(createEmpty());
        segmentWriter.call(this, feature, geometry);
      }
    }

    if (register) {
      this.featureChangeListenerKeys_[feature_uid] = listen(
        feature,
        EventType.CHANGE,
        this.handleFeatureChange_, this);
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature.
   * @private
   */
  forEachFeatureAdd_(feature) {
    this.addFeature(feature);
  }

  /**
   * @param {import("../Feature.js").default} feature Feature.
   * @private
   */
  forEachFeatureRemove_(feature) {
    this.removeFeature(feature);
  }

  /**
   * @return {import("../Collection.js").default<import("../Feature.js").default>|Array<import("../Feature.js").default>} Features.
   * @private
   */
  getFeatures_() {
    let features;
    if (this.features_) {
      features = this.features_;
    } else if (this.source_) {
      features = this.source_.getFeatures();
    }
    return (
      /** @type {!Array<import("../Feature.js").default>|!import("../Collection.js").default<import("../Feature.js").default>} */ (features)
    );
  }

  /**
   * @param {import("../source/Vector.js").default|import("../Collection.js").CollectionEvent} evt Event.
   * @private
   */
  handleFeatureAdd_(evt) {
    let feature;
    if (evt instanceof VectorSourceEvent) {
      feature = evt.feature;
    } else if (evt instanceof CollectionEvent) {
      feature = evt.element;
    }
    this.addFeature(/** @type {import("../Feature.js").default} */ (feature));
  }

  /**
   * @param {import("../source/Vector.js").default|import("../Collection.js").CollectionEvent} evt Event.
   * @private
   */
  handleFeatureRemove_(evt) {
    let feature;
    if (evt instanceof VectorSourceEvent) {
      feature = evt.feature;
    } else if (evt instanceof CollectionEvent) {
      feature = evt.element;
    }
    this.removeFeature(/** @type {import("../Feature.js").default} */ (feature));
  }

  /**
   * @param {import("../events/Event.js").default} evt Event.
   * @private
   */
  handleFeatureChange_(evt) {
    const feature = /** @type {import("../Feature.js").default} */ (evt.target);
    if (this.handlingDownUpSequence) {
      const uid = getUid(feature);
      if (!(uid in this.pendingFeatures_)) {
        this.pendingFeatures_[uid] = feature;
      }
    } else {
      this.updateFeature_(feature);
    }
  }

  /**
   * Remove a feature from the collection of features that we may snap to.
   * @param {import("../Feature.js").default} feature Feature
   * @param {boolean=} opt_unlisten Whether to unlisten to the feature change
   *     or not. Defaults to `true`.
   * @api
   */
  removeFeature(feature, opt_unlisten) {
    const unregister = opt_unlisten !== undefined ? opt_unlisten : true;
    const feature_uid = getUid(feature);
    const extent = this.indexedFeaturesExtents_[feature_uid];
    if (extent) {
      const rBush = this.rBush_;
      const nodesToRemove = [];
      rBush.forEachInExtent(extent, function(node) {
        if (feature === node.feature) {
          nodesToRemove.push(node);
        }
      });
      for (let i = nodesToRemove.length - 1; i >= 0; --i) {
        rBush.remove(nodesToRemove[i]);
      }
    }

    if (unregister) {
      unlistenByKey(this.featureChangeListenerKeys_[feature_uid]);
      delete this.featureChangeListenerKeys_[feature_uid];
    }
  }

  /**
   * @inheritDoc
   */
  setMap(map) {
    const currentMap = this.getMap();
    const keys = this.featuresListenerKeys_;
    const features = this.getFeatures_();

    if (currentMap) {
      keys.forEach(unlistenByKey);
      keys.length = 0;
      features.forEach(this.forEachFeatureRemove_.bind(this));
    }
    super.setMap(map);

    if (map) {
      if (this.features_) {
        keys.push(
          listen(this.features_, CollectionEventType.ADD,
            this.handleFeatureAdd_, this),
          listen(this.features_, CollectionEventType.REMOVE,
            this.handleFeatureRemove_, this)
        );
      } else if (this.source_) {
        keys.push(
          listen(this.source_, VectorEventType.ADDFEATURE,
            this.handleFeatureAdd_, this),
          listen(this.source_, VectorEventType.REMOVEFEATURE,
            this.handleFeatureRemove_, this)
        );
      }
      features.forEach(this.forEachFeatureAdd_.bind(this));
    }
  }

  /**
   * @param {import("../pixel.js").Pixel} pixel Pixel
   * @param {import("../coordinate.js").Coordinate} pixelCoordinate Coordinate
   * @param {import("../PluggableMap.js").default} map Map.
   * @return {Result} Snap result
   */
  snapTo(pixel, pixelCoordinate, map) {

    const lowerLeft = map.getCoordinateFromPixel(
      [pixel[0] - this.pixelTolerance_, pixel[1] + this.pixelTolerance_]);
    const upperRight = map.getCoordinateFromPixel(
      [pixel[0] + this.pixelTolerance_, pixel[1] - this.pixelTolerance_]);
    const box = boundingExtent([lowerLeft, upperRight]);

    let segments = this.rBush_.getInExtent(box);

    // If snapping on vertices only, don't consider circles
    if (this.vertex_ && !this.edge_) {
      segments = segments.filter(function(segment) {
        return segment.feature.getGeometry().getType() !==
            GeometryType.CIRCLE;
      });
    }

    let snappedToVertex = false;
    let snapped = false;
    let vertex = null;
    let vertexPixel = null;
    let dist, pixel1, pixel2, squaredDist1, squaredDist2;
    if (segments.length > 0) {
      this.pixelCoordinate_ = pixelCoordinate;
      segments.sort(this.sortByDistance_);
      const closestSegment = segments[0].segment;
      const isCircle = segments[0].feature.getGeometry().getType() ===
          GeometryType.CIRCLE;
      if (this.vertex_ && !this.edge_) {
        pixel1 = map.getPixelFromCoordinate(closestSegment[0]);
        pixel2 = map.getPixelFromCoordinate(closestSegment[1]);
        squaredDist1 = squaredCoordinateDistance(pixel, pixel1);
        squaredDist2 = squaredCoordinateDistance(pixel, pixel2);
        dist = Math.sqrt(Math.min(squaredDist1, squaredDist2));
        snappedToVertex = dist <= this.pixelTolerance_;
        if (snappedToVertex) {
          snapped = true;
          vertex = squaredDist1 > squaredDist2 ? closestSegment[1] : closestSegment[0];
          vertexPixel = map.getPixelFromCoordinate(vertex);
        }
      } else if (this.edge_) {
        if (isCircle) {
          vertex = closestOnCircle(pixelCoordinate,
            /** @type {import("../geom/Circle.js").default} */ (segments[0].feature.getGeometry()));
        } else {
          vertex = closestOnSegment(pixelCoordinate, closestSegment);
        }
        vertexPixel = map.getPixelFromCoordinate(vertex);
        if (coordinateDistance(pixel, vertexPixel) <= this.pixelTolerance_) {
          snapped = true;
          if (this.vertex_ && !isCircle) {
            pixel1 = map.getPixelFromCoordinate(closestSegment[0]);
            pixel2 = map.getPixelFromCoordinate(closestSegment[1]);
            squaredDist1 = squaredCoordinateDistance(vertexPixel, pixel1);
            squaredDist2 = squaredCoordinateDistance(vertexPixel, pixel2);
            dist = Math.sqrt(Math.min(squaredDist1, squaredDist2));
            snappedToVertex = dist <= this.pixelTolerance_;
            if (snappedToVertex) {
              vertex = squaredDist1 > squaredDist2 ? closestSegment[1] : closestSegment[0];
              vertexPixel = map.getPixelFromCoordinate(vertex);
            }
          }
        }
      }
      if (snapped) {
        vertexPixel = [Math.round(vertexPixel[0]), Math.round(vertexPixel[1])];
      }
    }
    return (
      /** @type {Result} */ ({
        snapped: snapped,
        vertex: vertex,
        vertexPixel: vertexPixel
      })
    );
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @private
   */
  updateFeature_(feature) {
    this.removeFeature(feature, false);
    this.addFeature(feature, false);
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/Circle.js").default} geometry Geometry.
   * @private
   */
  writeCircleGeometry_(feature, geometry) {
    const polygon = fromCircle(geometry);
    const coordinates = polygon.getCoordinates()[0];
    for (let i = 0, ii = coordinates.length - 1; i < ii; ++i) {
      const segment = coordinates.slice(i, i + 2);
      const segmentData = /** @type {SegmentData} */ ({
        feature: feature,
        segment: segment
      });
      this.rBush_.insert(boundingExtent(segment), segmentData);
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/GeometryCollection.js").default} geometry Geometry.
   * @private
   */
  writeGeometryCollectionGeometry_(feature, geometry) {
    const geometries = geometry.getGeometriesArray();
    for (let i = 0; i < geometries.length; ++i) {
      const segmentWriter = this.SEGMENT_WRITERS_[geometries[i].getType()];
      if (segmentWriter) {
        segmentWriter.call(this, feature, geometries[i]);
      }
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/LineString.js").default} geometry Geometry.
   * @private
   */
  writeLineStringGeometry_(feature, geometry) {
    const coordinates = geometry.getCoordinates();
    for (let i = 0, ii = coordinates.length - 1; i < ii; ++i) {
      const segment = coordinates.slice(i, i + 2);
      const segmentData = /** @type {SegmentData} */ ({
        feature: feature,
        segment: segment
      });
      this.rBush_.insert(boundingExtent(segment), segmentData);
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/MultiLineString.js").default} geometry Geometry.
   * @private
   */
  writeMultiLineStringGeometry_(feature, geometry) {
    const lines = geometry.getCoordinates();
    for (let j = 0, jj = lines.length; j < jj; ++j) {
      const coordinates = lines[j];
      for (let i = 0, ii = coordinates.length - 1; i < ii; ++i) {
        const segment = coordinates.slice(i, i + 2);
        const segmentData = /** @type {SegmentData} */ ({
          feature: feature,
          segment: segment
        });
        this.rBush_.insert(boundingExtent(segment), segmentData);
      }
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/MultiPoint.js").default} geometry Geometry.
   * @private
   */
  writeMultiPointGeometry_(feature, geometry) {
    const points = geometry.getCoordinates();
    for (let i = 0, ii = points.length; i < ii; ++i) {
      const coordinates = points[i];
      const segmentData = /** @type {SegmentData} */ ({
        feature: feature,
        segment: [coordinates, coordinates]
      });
      this.rBush_.insert(geometry.getExtent(), segmentData);
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/MultiPolygon.js").default} geometry Geometry.
   * @private
   */
  writeMultiPolygonGeometry_(feature, geometry) {
    const polygons = geometry.getCoordinates();
    for (let k = 0, kk = polygons.length; k < kk; ++k) {
      const rings = polygons[k];
      for (let j = 0, jj = rings.length; j < jj; ++j) {
        const coordinates = rings[j];
        for (let i = 0, ii = coordinates.length - 1; i < ii; ++i) {
          const segment = coordinates.slice(i, i + 2);
          const segmentData = /** @type {SegmentData} */ ({
            feature: feature,
            segment: segment
          });
          this.rBush_.insert(boundingExtent(segment), segmentData);
        }
      }
    }
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/Point.js").default} geometry Geometry.
   * @private
   */
  writePointGeometry_(feature, geometry) {
    const coordinates = geometry.getCoordinates();
    const segmentData = /** @type {SegmentData} */ ({
      feature: feature,
      segment: [coordinates, coordinates]
    });
    this.rBush_.insert(geometry.getExtent(), segmentData);
  }

  /**
   * @param {import("../Feature.js").default} feature Feature
   * @param {import("../geom/Polygon.js").default} geometry Geometry.
   * @private
   */
  writePolygonGeometry_(feature, geometry) {
    const rings = geometry.getCoordinates();
    for (let j = 0, jj = rings.length; j < jj; ++j) {
      const coordinates = rings[j];
      for (let i = 0, ii = coordinates.length - 1; i < ii; ++i) {
        const segment = coordinates.slice(i, i + 2);
        const segmentData = /** @type {SegmentData} */ ({
          feature: feature,
          segment: segment
        });
        this.rBush_.insert(boundingExtent(segment), segmentData);
      }
    }
  }
}


/**
 * Handle all pointer events events.
 * @param {import("../MapBrowserEvent.js").default} evt A move event.
 * @return {boolean} Pass the event to other interactions.
 * @this {Snap}
 */
export function handleEvent(evt) {
  const result = this.snapTo(evt.pixel, evt.coordinate, evt.map);
  if (result.snapped) {
    evt.coordinate = result.vertex.slice(0, 2);
    evt.pixel = result.vertexPixel;
  }
  return handlePointerEvent.call(this, evt);
}


/**
 * @param {import("../MapBrowserPointerEvent.js").default} evt Event.
 * @return {boolean} Stop drag sequence?
 * @this {Snap}
 */
function handleUpEvent(evt) {
  const featuresToUpdate = getValues(this.pendingFeatures_);
  if (featuresToUpdate.length) {
    featuresToUpdate.forEach(this.updateFeature_.bind(this));
    this.pendingFeatures_ = {};
  }
  return false;
}


/**
 * Sort segments by distance, helper function
 * @param {SegmentData} a The first segment data.
 * @param {SegmentData} b The second segment data.
 * @return {number} The difference in distance.
 * @this {Snap}
 */
function sortByDistance(a, b) {
  const deltaA = squaredDistanceToSegment(this.pixelCoordinate_, a.segment);
  const deltaB = squaredDistanceToSegment(this.pixelCoordinate_, b.segment);
  return deltaA - deltaB;
}

export default Snap;
