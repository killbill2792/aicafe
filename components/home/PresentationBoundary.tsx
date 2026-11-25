"use client";
import {Component,type ReactNode} from "react";

/** A failed optional visual never takes the surrounding answer down. */
export default class PresentationBoundary extends Component<{children:ReactNode;fallback?:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?this.props.fallback??null:this.props.children;}
}
